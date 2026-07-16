/**
 * Debounce + dedup + aggregate state machine for status.claude.com webhooks.
 *
 * WHY: a single degradation arrives as a BURST of 3-7 `component_update` events
 * within 4-18s (one per surface: claude.ai, API, Code, Cowork, Console...), and
 * recovery as a second burst. Firing one push per hit buried the user under 5
 * near-identical notifications. This coalesces each burst into ONE push and:
 *   - suppresses intermediate incident-status churn (investigating->identified->
 *     monitoring) once we've already alerted the degradation,
 *   - swallows flaps entirely: a degrade + restore landing inside one window
 *     nets to zero, so nothing is sent,
 *   - names the affected models/surfaces (from the incident payload) instead of
 *     a bare "a service is degraded".
 *
 * Baseline (last-notified state) is persisted in KV so bursts separated by
 * minutes, and broker restarts between bursts, diff correctly.
 */

import type { StoreDriver } from '../store/types'
import {
  type IncidentInfo,
  impactRank,
  isImpaired,
  maxRank,
  normalize,
  renderDegrade,
  renderRecovery,
} from './statuspage-render'

/** kv key holding the last-notified status baseline. */
const STATE_KEY = 'statuspage:state'
/** Default trailing quiet period before a burst is flushed (env-tunable). */
export const DEFAULT_WINDOW_MS = 45_000

interface Baseline {
  /** last-flushed status per component name. */
  components: Record<string, string>
  /** did we send a degrade alert that has not yet been "recovered"? */
  alerted: boolean
  /** incident context carried for the recovery message + escalation diffing. */
  incidentName?: string
  incidentImpact?: string
}

interface Pending {
  components: Record<string, string>
  incident?: IncidentInfo
}

/** Injectable so tests drive the window without real timers. */
export interface Scheduler {
  schedule(fn: () => void, ms: number): unknown
  cancel(handle: unknown): void
}

const realScheduler: Scheduler = {
  schedule: (fn, ms) => setTimeout(fn, ms),
  cancel: h => clearTimeout(h as ReturnType<typeof setTimeout>),
}

export interface AggregatorDeps {
  store: StoreDriver
  sendPush: (push: { title: string; body: string; data?: Record<string, unknown> }) => void
  windowMs?: number
  scheduler?: Scheduler
}

export class StatuspageAggregator {
  private readonly store: StoreDriver
  private readonly sendPush: AggregatorDeps['sendPush']
  private readonly windowMs: number
  private readonly scheduler: Scheduler
  private pending: Pending | null = null
  private timer: unknown = null

  constructor(deps: AggregatorDeps) {
    this.store = deps.store
    this.sendPush = deps.sendPush
    this.windowMs = deps.windowMs ?? DEFAULT_WINDOW_MS
    this.scheduler = deps.scheduler ?? realScheduler
  }

  /** Feed one raw webhook payload. Returns false if the event was ignored. */
  ingest(payload: Record<string, unknown>): boolean {
    const ev = normalize(payload)
    if (ev.ignore) return false

    if (!this.pending) this.pending = { components: {} }
    Object.assign(this.pending.components, ev.components)
    if (ev.incident) this.pending.incident = ev.incident

    if (this.timer) this.scheduler.cancel(this.timer)
    this.timer = this.scheduler.schedule(() => this.flush(), this.windowMs)
    return true
  }

  /** Collapse the accumulated burst into at most one push, then update baseline. */
  flush(): void {
    this.timer = null
    const pending = this.pending
    this.pending = null
    if (!pending) return

    const base = this.readState()
    const components = { ...base.components, ...pending.components }
    const impaired = this.impairedOf(components)
    const next = Object.keys(impaired).length ? this.onImpaired(base, impaired, pending.incident) : this.onClear(base)

    this.writeState({ components, ...next })
  }

  /** Decide whether an impaired burst is a fresh/worse alert, and carry state forward. */
  private onImpaired(
    base: Baseline,
    impaired: Record<string, string>,
    incident: IncidentInfo | undefined,
  ): Omit<Baseline, 'components'> {
    if (!base.alerted || this.worsened(base, impaired, incident)) {
      const known = this.knownIncident(base, incident)
      this.sendPush({ ...renderDegrade(impaired, known), data: { kind: 'degraded', components: impaired } })
    }
    // State always absorbs the latest incident context (for the recovery text).
    return {
      alerted: true,
      incidentName: incident?.name ?? base.incidentName,
      incidentImpact: incident?.impact ?? base.incidentImpact,
    }
  }

  /**
   * Re-buzz only on a REAL worsening: a severity tier up (degraded->partial->
   * major) or an incident impact rise. Merely adding another surface at an
   * already-alerted tier, or the incident landing 10-17min later to name the
   * model, does NOT worsen -- that is the anti-storm rule.
   */
  private worsened(base: Baseline, impaired: Record<string, string>, incident: IncidentInfo | undefined): boolean {
    if (maxRank(impaired) > maxRank(this.impairedOf(base.components))) return true
    if (incident === undefined || base.incidentImpact === undefined) return false
    return impactRank(incident.impact) > impactRank(base.incidentImpact)
  }

  /** The incident to render with -- the fresh one, else the model learned earlier this episode. */
  private knownIncident(base: Baseline, incident: IncidentInfo | undefined): IncidentInfo | undefined {
    if (incident) return incident
    if (!base.incidentName) return undefined
    return { name: base.incidentName, status: 'identified', impact: base.incidentImpact ?? 'none' }
  }

  /** All surfaces clear: fire a recovery push only if a degradation was alerted. */
  private onClear(base: Baseline): Omit<Baseline, 'components'> {
    if (base.alerted) this.sendPush({ ...renderRecovery(base.incidentName), data: { kind: 'recovered' } })
    return { alerted: false, incidentName: undefined, incidentImpact: undefined }
  }

  /** Impaired subset of a component map. */
  private impairedOf(components: Record<string, string>): Record<string, string> {
    const out: Record<string, string> = {}
    for (const [name, status] of Object.entries(components)) if (isImpaired(status)) out[name] = status
    return out
  }

  private readState(): Baseline {
    try {
      const s = this.store.kv.get<Baseline>(STATE_KEY)
      if (s?.components) return s
    } catch (err) {
      console.error('[statuspage] state read failed:', err instanceof Error ? err.message : err)
    }
    return { components: {}, alerted: false }
  }

  private writeState(state: Baseline): void {
    try {
      this.store.kv.set(STATE_KEY, state)
    } catch (err) {
      console.error('[statuspage] state write failed:', err instanceof Error ? err.message : err)
    }
  }
}
