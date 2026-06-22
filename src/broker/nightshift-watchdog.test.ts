/**
 * Nightshift watchdog tests -- the deterministic cap evaluation (pure), the
 * decision-log ring, and one end-to-end sweep proving the kill + dedup paths.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import { DEFAULT_NIGHTSHIFT_CONFIG } from '../shared/nightshift-types'
import type { Conversation, ProfileUsageSnapshot } from '../shared/protocol'
import { evaluate, resolveCaps, startNightshiftWatchdog, type WatchdogDeps } from './nightshift-watchdog'
import {
  __clearWatchdogDecisionsForTest,
  getRecentWatchdogDecisions,
  recordWatchdogDecision,
} from './nightshift-watchdog-log'

const T0 = 1_700_000_000_000 // fixed clock base
const CAPS = resolveCaps(DEFAULT_NIGHTSHIFT_CONFIG) // {120m, 20m idle, 2M tok, 80 turns}

/** Minimal Conversation with the fields the watchdog reads; everything else nulled. */
function makeConv(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    project: 'claude:///Users/jonas/projects/demo',
    status: 'active',
    startedAt: T0,
    lastActivity: T0,
    resolvedProfile: 'work',
    hostSentinelId: 'sent-1',
    launchConfig: { headless: true, nightshift: { runId: '2026-06-22', taskId: '002' } },
    stats: {
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalCacheCreation: 0,
      totalCacheWrite5m: 0,
      totalCacheWrite1h: 0,
      totalCacheRead: 0,
      turnCount: 0,
      toolCallCount: 0,
      compactionCount: 0,
      linesAdded: 0,
      linesRemoved: 0,
      totalApiDurationMs: 0,
    },
    ...overrides,
  } as unknown as Conversation
}

const noUsage: Pick<WatchdogDeps, 'getSentinelProfileUsage'> = { getSentinelProfileUsage: () => undefined }

function usageAt(pct: number): Pick<WatchdogDeps, 'getSentinelProfileUsage'> {
  return {
    getSentinelProfileUsage: () => ({
      polledAt: T0,
      profiles: [
        {
          profile: 'work',
          authed: true,
          polledAt: T0,
          fiveHour: { usedPercent: pct, resetAt: '' },
        } as ProfileUsageSnapshot,
      ],
    }),
  }
}

describe('evaluate -- deterministic caps', () => {
  test('within all caps => observe, with full metric snapshot', () => {
    const d = evaluate(makeConv(), '2026-06-22', '002', CAPS, noUsage, T0 + 60_000)
    expect(d.verdict).toBe('observe')
    expect(d.kind).toBeUndefined()
    expect(d.elapsedMin).toBe(1)
    expect(d.turns).toBe(0)
    expect(d.caps?.perTaskMinutes).toBe(120)
  })

  test('wall-clock cap breach => end (time)', () => {
    const d = evaluate(makeConv(), 'r', 't', CAPS, noUsage, T0 + 121 * 60_000)
    expect(d.verdict).toBe('end')
    expect(d.kind).toBe('time')
  })

  test('token cap breach => end (tokens)', () => {
    const conv = makeConv({ stats: { ...makeConv().stats, totalInputTokens: 1_500_000, totalOutputTokens: 600_000 } })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 60_000)
    expect(d.verdict).toBe('end')
    expect(d.kind).toBe('tokens')
  })

  test('turn cap breach => end (turns)', () => {
    const conv = makeConv({ stats: { ...makeConv().stats, turnCount: 81 } })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 60_000)
    expect(d.verdict).toBe('end')
    expect(d.kind).toBe('turns')
  })

  test('idle cap breach => end (idle)', () => {
    // lastActivity 21m ago, but started 30m ago (under the time cap)
    const conv = makeConv({ startedAt: T0, lastActivity: T0 + 9 * 60_000 })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 30 * 60_000)
    expect(d.verdict).toBe('end')
    expect(d.kind).toBe('idle')
  })

  test('approaching a cap => warn (no action)', () => {
    // 85% of 80 turns = 68
    const conv = makeConv({ stats: { ...makeConv().stats, turnCount: 70 } })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 60_000)
    expect(d.verdict).toBe('warn')
    expect(d.kind).toBe('turns')
  })

  test('recent rate-limit => block (transient, shelve)', () => {
    const conv = makeConv({ rateLimit: { message: '429 overloaded', timestamp: T0 + 30_000, profile: 'work' } })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 60_000)
    expect(d.verdict).toBe('block')
    expect(d.kind).toBe('rate-limit')
  })

  test('stale rate-limit is ignored', () => {
    // rate-limit stamp is 20m old (stale); keep idle/time under their caps so
    // ONLY the (ignored) rate-limit could fire.
    const conv = makeConv({
      lastActivity: T0 + 19 * 60_000,
      rateLimit: { message: '429', timestamp: T0, profile: 'work' },
    })
    const d = evaluate(conv, 'r', 't', CAPS, noUsage, T0 + 20 * 60_000)
    expect(d.verdict).toBe('observe')
  })

  test('capacity floor crossed => block (capacity-floor)', () => {
    const d = evaluate(makeConv(), 'r', 't', CAPS, usageAt(80), T0 + 60_000)
    expect(d.verdict).toBe('block')
    expect(d.kind).toBe('capacity-floor')
    expect(d.fiveHourPct).toBe(80)
  })

  test('capacity below the gate => no floor action', () => {
    const d = evaluate(makeConv(), 'r', 't', CAPS, usageAt(50), T0 + 60_000)
    expect(d.verdict).toBe('observe')
    expect(d.fiveHourPct).toBe(50)
  })

  test('hard cap (end) dominates a transient block', () => {
    const conv = makeConv({
      stats: { ...makeConv().stats, turnCount: 81 },
      rateLimit: { message: '429', timestamp: T0 + 30_000, profile: 'work' },
    })
    const d = evaluate(conv, 'r', 't', CAPS, usageAt(90), T0 + 60_000)
    expect(d.verdict).toBe('end')
    expect(d.kind).toBe('turns')
  })
})

describe('decision-log ring', () => {
  beforeEach(() => __clearWatchdogDecisionsForTest())

  test('records + returns newest-first, filtered by project + run', () => {
    recordWatchdogDecision({
      id: 'a',
      at: 1,
      project: 'p1',
      runId: 'r1',
      taskId: '1',
      conversationId: 'c1',
      verdict: 'observe',
      reason: '',
    })
    recordWatchdogDecision({
      id: 'b',
      at: 2,
      project: 'p2',
      runId: 'r1',
      taskId: '2',
      conversationId: 'c2',
      verdict: 'observe',
      reason: '',
    })
    recordWatchdogDecision({
      id: 'c',
      at: 3,
      project: 'p1',
      runId: 'r2',
      taskId: '3',
      conversationId: 'c3',
      verdict: 'end',
      reason: '',
    })

    expect(getRecentWatchdogDecisions().map(d => d.id)).toEqual(['c', 'b', 'a'])
    expect(getRecentWatchdogDecisions({ project: 'p1' }).map(d => d.id)).toEqual(['c', 'a'])
    expect(getRecentWatchdogDecisions({ project: 'p1', runId: 'r1' }).map(d => d.id)).toEqual(['a'])
    expect(getRecentWatchdogDecisions({ limit: 1 }).map(d => d.id)).toEqual(['c'])
  })
})

describe('sweep -- end-to-end kill + dedup', () => {
  beforeEach(() => __clearWatchdogDecisionsForTest())

  function fakeDeps(convs: Conversation[], sent: string[]): { deps: WatchdogDeps; sent: string[] } {
    const deps: WatchdogDeps = {
      getActiveConversations: () => convs,
      getConversationSocket: () => ({ send: (m: string) => sent.push(m) }) as unknown as ServerWebSocket<unknown>,
      getGatewaySocket: () => undefined,
      endConversation: () => {},
      broadcastConversationUpdate: () => {},
      broadcastScoped: () => {},
      getSentinelProfileUsage: () => undefined,
      getSentinel: () => undefined, // no sentinel => artifact write resolves to error fast (no hang)
      getSentinelByAlias: () => undefined,
      addProjectListener: () => {},
      removeProjectListener: () => {},
      now: () => T0 + 200 * 60_000, // 200m elapsed => over the 120m time cap
    }
    return { deps, sent }
  }

  test('over-cap night task is terminated once; non-night task is ignored', () => {
    const night = makeConv({ id: 'night-1' })
    const ordinary = makeConv({ id: 'plain-1', launchConfig: { headless: true } }) // no nightshift tag
    const sentMsgs: string[] = []
    const { deps } = fakeDeps([night, ordinary], sentMsgs)

    const wd = startNightshiftWatchdog(deps) // runs sweep() immediately

    // Exactly one terminate, for the night task.
    const terminates = sentMsgs.filter(m => m.includes('terminate_conversation'))
    expect(terminates.length).toBe(1)
    expect(terminates[0]).toContain('night-1')
    expect(terminates[0]).toContain('nightshift-watchdog')

    // A decision was logged for the night task (LOG-EVERYTHING), none for the plain one.
    expect(getRecentWatchdogDecisions({}).filter(d => d.conversationId === 'night-1').length).toBe(1)
    expect(getRecentWatchdogDecisions({}).filter(d => d.conversationId === 'plain-1').length).toBe(0)

    wd.stop()
  })
})
