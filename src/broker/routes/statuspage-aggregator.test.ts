/**
 * Aggregator state machine: burst coalescing, flap suppression, escalation,
 * recovery gating, and model-named text. Drives the machine with a manual
 * scheduler (no real timers) and an in-memory kv, replaying the exact payload
 * shapes status.claude.com sends (verified against the live event ring).
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { StoreDriver } from '../store/types'
import { type Scheduler, StatuspageAggregator } from './statuspage-aggregator'

// ── Test doubles ─────────────────────────────────────────────────────────────

function makeStore(): StoreDriver {
  const map = new Map<string, unknown>()
  return {
    kv: {
      get: <T>(k: string) => (map.has(k) ? (map.get(k) as T) : null),
      set: (k: string, v: unknown) => void map.set(k, v),
      delete: (k: string) => map.delete(k),
      keys: (prefix?: string) => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
    },
  } as unknown as StoreDriver
}

/** Captures the pending flush so a test can fire it deterministically. */
function makeScheduler(): Scheduler & { fire: () => void; armed: boolean } {
  let pending: (() => void) | null = null
  return {
    schedule(fn) {
      pending = fn
      return {}
    },
    cancel() {
      pending = null
    },
    get armed() {
      return pending !== null
    },
    fire() {
      const fn = pending
      pending = null
      fn?.()
    },
  }
}

type Push = { title: string; body: string; data?: Record<string, unknown> }

function harness(windowMs = 45_000) {
  const pushes: Push[] = []
  const scheduler = makeScheduler()
  const agg = new StatuspageAggregator({
    store: makeStore(),
    windowMs,
    scheduler,
    sendPush: p => pushes.push(p),
  })
  return { agg, pushes, scheduler }
}

// ── Payload builders (real Statuspage shapes) ────────────────────────────────

const componentUpdate = (name: string, newStatus: string) => ({
  page: { status_indicator: 'minor' },
  component: { name, status: newStatus },
  component_update: { old_status: 'operational', new_status: newStatus },
})

const incident = (name: string, status: string, impact: string, comps: Array<[string, string]>, body?: string) => ({
  page: { status_description: 'Partially Degraded Service' },
  incident: {
    name,
    status,
    impact,
    incident_updates: body ? [{ body, status }] : [],
    components: comps.map(([n, s]) => ({ name: n, status: s })),
  },
})

const DEGRADE_BURST = [
  componentUpdate('claude.ai', 'degraded_performance'),
  componentUpdate('Claude API (api.anthropic.com)', 'degraded_performance'),
  componentUpdate('Claude Code', 'degraded_performance'),
  componentUpdate('Claude Cowork', 'degraded_performance'),
  componentUpdate('Claude Console (platform.claude.com)', 'degraded_performance'),
]
const RECOVER_BURST = DEGRADE_BURST.map(p => ({
  ...p,
  component_update: { old_status: 'degraded_performance', new_status: 'operational' },
  component: { ...p.component, status: 'operational' },
}))

// ── Tests ────────────────────────────────────────────────────────────────────

describe('StatuspageAggregator', () => {
  let h: ReturnType<typeof harness>
  beforeEach(() => {
    h = harness()
  })

  test('a 5-event degrade burst coalesces into ONE push', () => {
    for (const p of DEGRADE_BURST) h.agg.ingest(p)
    expect(h.pushes).toHaveLength(0) // nothing before the window flushes
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].body).toContain('claude.ai')
    expect(h.pushes[0].body).toContain('+2 more')
    expect(h.pushes[0].data?.kind).toBe('degraded')
  })

  test('re-arms the window on every event (debounce)', () => {
    h.agg.ingest(DEGRADE_BURST[0])
    expect(h.scheduler.armed).toBe(true)
    h.agg.ingest(DEGRADE_BURST[1])
    expect(h.scheduler.armed).toBe(true)
    h.scheduler.fire()
    expect(h.scheduler.armed).toBe(false)
  })

  test('degrade + restore inside one window nets to zero -> NO push (flap)', () => {
    for (const p of DEGRADE_BURST) h.agg.ingest(p)
    for (const p of RECOVER_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(0)
  })

  test('degrade then recovery in SEPARATE windows -> degrade push, then recovery push', () => {
    for (const p of DEGRADE_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].data?.kind).toBe('degraded')

    for (const p of RECOVER_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(2)
    expect(h.pushes[1].data?.kind).toBe('recovered')
    expect(h.pushes[1].title).toBe('Claude recovered')
  })

  test('recovery with no prior alert is silent', () => {
    for (const p of RECOVER_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(0)
  })

  test('intermediate incident-status churn after an alert is suppressed', () => {
    const comps: Array<[string, string]> = [['claude.ai', 'degraded_performance']]
    h.agg.ingest(incident('Elevated errors on Opus 4.8', 'investigating', 'minor', comps, 'Investigating.'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    // identified -> monitoring: same component still degraded, no new/worse -> silent
    h.agg.ingest(incident('Elevated errors on Opus 4.8', 'identified', 'minor', comps, 'Fix implemented.'))
    h.scheduler.fire()
    h.agg.ingest(incident('Elevated errors on Opus 4.8', 'monitoring', 'minor', comps, 'Monitoring.'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
  })

  test('impact escalation after an alert re-notifies', () => {
    const comps: Array<[string, string]> = [['claude.ai', 'degraded_performance']]
    h.agg.ingest(incident('Elevated errors', 'identified', 'minor', comps))
    h.scheduler.fire()
    h.agg.ingest(incident('Elevated errors', 'identified', 'critical', comps))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(2)
    expect(h.pushes[1].title).toContain('[critical]')
  })

  test('another surface at the SAME tier after an alert is silent (anti-storm)', () => {
    h.agg.ingest(componentUpdate('claude.ai', 'degraded_performance'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    h.agg.ingest(componentUpdate('Claude Code', 'degraded_performance'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1) // same severity tier -> no fresh buzz
  })

  test('a severity-tier increase (degraded -> major outage) re-notifies', () => {
    h.agg.ingest(componentUpdate('claude.ai', 'degraded_performance'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    h.agg.ingest(componentUpdate('claude.ai', 'major_outage'))
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(2)
    expect(h.pushes[1].body).toContain('major outage')
  })

  test('incident naming the model arrives late but at same tier -> silent, yet names model on recovery', () => {
    // Real pattern: component burst first, incident (with model) ~15min later.
    for (const p of DEGRADE_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    expect(h.pushes[0].title).toBe('Claude: degraded') // no model yet
    // Incident lands a window later, same minor impact -> folded silently.
    h.agg.ingest(
      incident('Elevated errors on Claude Opus 4.8', 'identified', 'minor', [['claude.ai', 'degraded_performance']]),
    )
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(1)
    // Recovery now names the model we learned mid-episode.
    for (const p of RECOVER_BURST) h.agg.ingest(p)
    h.scheduler.fire()
    expect(h.pushes).toHaveLength(2)
    expect(h.pushes[1].body).toContain('Claude Opus 4.8')
  })

  test('incident push names the model in the title', () => {
    h.agg.ingest(
      incident(
        'Elevated errors on Claude Opus 4.8',
        'investigating',
        'minor',
        [
          ['claude.ai', 'degraded_performance'],
          ['Claude API (api.anthropic.com)', 'degraded_performance'],
        ],
        'We are investigating.',
      ),
    )
    h.scheduler.fire()
    expect(h.pushes[0].title).toBe('Claude: Elevated errors on Claude Opus 4.8 [minor]')
    expect(h.pushes[0].body).toContain('We are investigating.')
  })

  test('selftest and page-only pings are dropped', () => {
    expect(h.agg.ingest({ page: { status_description: 'Test' }, incident: { name: 'SELFTEST ignore' } })).toBe(false)
    expect(h.agg.ingest({ page: { status_description: 'All Systems Operational' } })).toBe(false)
    expect(h.scheduler.armed).toBe(false)
  })

  test('baseline survives across aggregator instances (kv-persisted)', () => {
    const store = makeStore()
    const s1 = makeScheduler()
    const p1: Push[] = []
    const a1 = new StatuspageAggregator({ store, windowMs: 1, scheduler: s1, sendPush: p => p1.push(p) })
    for (const p of DEGRADE_BURST) a1.ingest(p)
    s1.fire()
    expect(p1).toHaveLength(1)

    // New instance (simulating a broker restart) reads the persisted baseline:
    const s2 = makeScheduler()
    const p2: Push[] = []
    const a2 = new StatuspageAggregator({ store, windowMs: 1, scheduler: s2, sendPush: p => p2.push(p) })
    for (const p of RECOVER_BURST) a2.ingest(p)
    s2.fire()
    expect(p2).toHaveLength(1)
    expect(p2[0].data?.kind).toBe('recovered')
  })
})
