/**
 * SOTU git-fabric scan scheduler (Phase 2) -- the derived-state floor.
 *
 * The integration ladder is part of the ALWAYS-ON free floor (zero-LLM): it
 * MEASURES whether work integrated (so the decay engine can collapse landed work)
 * and ESCALATES at-risk/unpushed/stalled work. This module is the broker-side
 * trigger: it watches the desk-event bus and, debounced per project, asks the
 * sentinel to run the ladder (boundary: the broker never touches the host FS) and
 * appends the snapshot as a `git_scan` contribution via the same chokepoint the
 * lifecycle floor uses.
 *
 * Three triggers feed ONE per-project schedule (all coalesced, all floored):
 *   - LIFECYCLE: a conv opening/closing is when integration state most likely
 *     changed. Debounced: trailing settle + MIN_INTERVAL floor.
 *   - READ (scan-on-read): a sheaf read schedules a scan, so a fix made outside
 *     any conversation (a manual terminal commit) stops showing a stale alert
 *     on the next refresh. Same floor -- opening the sheaf twice in five
 *     minutes does not double-scan.
 *   - PERIODIC: after each scan, IF the project shows recent LLM activity
 *     (`hasRecentActivity`), re-arm a PERIODIC_MS rescan so alerts track a busy
 *     fleet even between lifecycle events. No activity -> DEEP SLEEP: no timer,
 *     zero cost, until the next lifecycle event or read wakes the project.
 */

import { onDeskEvent } from '../desk/event-registry'
import { recordContribution } from './contribute'
import { type GitFabricTransport, gatherGitFabric } from './git-fabric-gather'
import { projectSlug } from './paths'
import type { GitScanContrib } from './types'

/** Hard floor on per-project scan frequency (the ladder is cheap but not free in
 *  a busy fleet). */
const MIN_INTERVAL_MS = 5 * 60_000
/** Trailing settle: let a burst of lifecycle events quiesce before scanning. */
const QUIET_SETTLE_MS = 30_000
/** Periodic rescan cadence while the project shows LLM activity. */
const PERIODIC_MS = 20 * 60_000

type ScanReason = 'lifecycle' | 'read' | 'periodic'

export interface GitScanDeps {
  transport: GitFabricTransport
  /** Broadcast the `sotu_contribution` notice to authorized dashboards. */
  broadcast: (message: Record<string, unknown>, project: string) => void
  /** Recent-LLM-activity probe: does this project have a conversation that is
   *  active now or was active within the given window? Gates the PERIODIC
   *  rescan -- absent means periodic rescans never arm (lifecycle/read only). */
  hasRecentActivity?: (project: string, windowMs: number) => boolean
  now?: () => number
  log?: (msg: string) => void
  /** Per-project scan-frequency floor (override for tests). */
  minIntervalMs?: number
  /** Trailing settle window (override for tests). */
  quietSettleMs?: number
  /** Periodic cadence (override for tests). */
  periodicMs?: number
}

interface Scheduler {
  /** Schedule a debounced scan for a project (all triggers funnel here). */
  schedule: (project: string, reason: ScanReason) => void
  stop: () => void
}

let current: Scheduler | null = null

// fallow-ignore-next-line complexity
function createScheduler(deps: GitScanDeps): Scheduler {
  const now = deps.now ?? (() => Date.now())
  const log = deps.log ?? (() => {})
  const minIntervalMs = deps.minIntervalMs ?? MIN_INTERVAL_MS
  const quietSettleMs = deps.quietSettleMs ?? QUIET_SETTLE_MS
  const periodicMs = deps.periodicMs ?? PERIODIC_MS
  const timers = new Map<string, ReturnType<typeof setTimeout>>()
  const lastScanAt = new Map<string, number>()

  const runScan = async (project: string): Promise<void> => {
    timers.delete(project)
    lastScanAt.set(project, now())
    const res = await gatherGitFabric(deps.transport, project)
    if (res.error || !res.fabric) {
      log(`[sotu] git-fabric scan skipped project=${project} -- ${res.error ?? 'no fabric'}`)
      return
    }
    const contrib: GitScanContrib = { kind: 'git_scan', convId: '', ts: now(), git: res.fabric }
    const { pendingContribs } = recordContribution(projectSlug(project), contrib, project)
    deps.broadcast(
      {
        type: 'sotu_contribution',
        project,
        pendingContribs,
        latest: { convId: '', kind: 'git_scan', ts: contrib.ts },
      },
      project,
    )
    const branches = res.fabric.branches.length
    const alerts = res.fabric.branches.reduce((n, b) => n + b.alerts.length, 0)
    log(`[sotu] git-fabric scan project=${project} branches=${branches} alerts=${alerts} pending=${pendingContribs}`)
    armPeriodic(project)
  }

  /** After a scan: keep polling while the project shows LLM activity, deep-sleep
   *  otherwise (the next lifecycle event or read wakes it). */
  function armPeriodic(project: string): void {
    if (!deps.hasRecentActivity) return
    if (timers.has(project)) return // something sooner is already pending
    if (!deps.hasRecentActivity(project, periodicMs + minIntervalMs)) {
      log(`[sotu] git-fabric periodic project=${project} -> deep sleep (no recent LLM activity)`)
      return
    }
    timers.set(
      project,
      setTimeout(() => schedule(project, 'periodic'), periodicMs),
    )
  }

  function schedule(project: string, reason: ScanReason): void {
    if (reason === 'periodic') timers.delete(project) // its own timer just fired
    if (timers.has(project)) return // coalesce: a scan is already pending
    const elapsed = now() - (lastScanAt.get(project) ?? 0)
    const delay = reason === 'periodic' ? 0 : Math.max(quietSettleMs, minIntervalMs - elapsed)
    timers.set(
      project,
      setTimeout(() => {
        void runScan(project)
      }, delay),
    )
  }

  const unsubscribe = onDeskEvent(event => {
    if (event.kind !== 'lifecycle' || !event.project) return
    schedule(event.project, 'lifecycle')
  })

  return {
    schedule,
    stop: () => {
      unsubscribe()
      for (const t of timers.values()) clearTimeout(t)
      timers.clear()
    },
  }
}

/** Start the scheduler. Idempotent. */
export function startSotuGitScan(deps: GitScanDeps): void {
  if (current) return
  current = createScheduler(deps)
}

/** Scan-on-read: a read surface (sheaf, SOTU view) asks for a fresh scan. Rides
 *  the same coalescing + MIN_INTERVAL floor, so hammering refresh cannot hammer
 *  the sentinel. No-op when the scheduler is not running. */
export function requestSotuScan(project: string): void {
  current?.schedule(project, 'read')
}

/** Stop the scheduler (clean broker shutdown + test isolation). */
export function stopSotuGitScan(): void {
  current?.stop()
  current = null
}
