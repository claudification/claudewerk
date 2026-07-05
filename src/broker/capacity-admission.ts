/**
 * CAPACITY ADMISSION -- the fill-slots policy loop (plan-quest-engine §9a/§9d/§9f).
 *
 * Separated from the orchestrator's I/O so the admission POLICY (admit / park /
 * starve) is a small, testable unit that mutates a run view and calls back for
 * the two side effects it needs -- dispatch a worker, or stamp a starved card.
 * The ledger owns the arithmetic + structured messages; this owns the ordering.
 */

import type { NightshiftQueueItem } from '../shared/nightshift-types'
import type { CapacityLedger } from './capacity-ledger'

/** Reservation ref for the live dispatch path -- the SAME key space the boot
 *  reconstruction rebuilds (`capacity-ledger.ts` §14). */
export function taskRefOf(runId: string, taskId: string): string {
  return `${runId}:${taskId}`
}

/** The slice of run state the admission loop reads/writes. `RunState` satisfies
 *  it structurally; `pending` is spliced (admitted/starved removed) and
 *  `sleepUntilMs` is set/cleared in place. */
export interface AdmissionRun {
  project: string
  runId: string
  /** Profiles the balanced picker may place this run's workers on (§9). */
  candidateProfiles: string[]
  /** Epoch ms the run window closes (starvation terminal). Undefined = no window. */
  windowEndMs?: number
  concurrency: number
  pending: NightshiftQueueItem[]
  inflight: Map<string, string>
  /** Computed-sleep gate: while `now < sleepUntilMs` the run parks (§9d). */
  sleepUntilMs?: number
}

export interface AdmissionCallbacks {
  /** Seed the running artifact + spawn the guarded worker (orchestrator I/O). */
  dispatch: (item: NightshiftQueueItem) => Promise<void>
  /** Stamp a task SKIPPED(capacity) in the run report (§9f). */
  starveCard: (item: NightshiftQueueItem, reason: string) => Promise<void>
  now?: () => number
}

/**
 * Capacity-gated fill: admit as many queued tasks as HEADROOM allows (emptiest
 * profile first), leaving denied tasks queued -- never errored (§9a). When the
 * window has closed and nothing is left running to free capacity, stamp the
 * remainder SKIPPED(capacity) (§9f). Otherwise, if nothing admits and nothing is
 * running, park until the computed window roll-off (§9d); if workers are still in
 * flight, the reap tick re-advances as they free capacity.
 */
export async function fillSlotsWithAdmission(
  ledger: CapacityLedger,
  run: AdmissionRun,
  cb: AdmissionCallbacks,
): Promise<void> {
  const now = (cb.now ?? Date.now)()

  if (run.windowEndMs !== undefined && now >= run.windowEndMs) {
    if (run.inflight.size === 0 && run.pending.length > 0) await starveAll(ledger, run, cb, now)
    return
  }
  if (run.sleepUntilMs !== undefined && now < run.sleepUntilMs) return // parked (§9d)
  run.sleepUntilMs = undefined

  const earliestWake = await admitAvailable(ledger, run, cb, now)

  // Nothing running to free capacity, tasks remain, and a window roll-off is
  // known -> park until then (§9d). If workers are in flight, the reap tick
  // re-advances when they settle, so we don't sleep on that path.
  if (run.inflight.size === 0 && run.pending.length > 0 && earliestWake !== undefined) {
    run.sleepUntilMs = earliestWake
  }
}

/** Admit as many queued tasks as headroom allows (emptiest profile first),
 *  leaving denied tasks queued. Returns the soonest computed wake across the
 *  denied tasks (§9d), or undefined when none carried a reset clock. */
async function admitAvailable(
  ledger: CapacityLedger,
  run: AdmissionRun,
  cb: AdmissionCallbacks,
  now: number,
): Promise<number | undefined> {
  let earliestWake: number | undefined
  let i = 0
  while (run.inflight.size < run.concurrency && i < run.pending.length) {
    const item = run.pending[i]
    const estimate = item.estimateTokens ?? ledger.defaultEstimate
    const ctx = { project: run.project, runId: run.runId, taskId: item.id }
    const res = ledger.admitBest(ctx, run.candidateProfiles, estimate, taskRefOf(run.runId, item.id), {
      now,
      windowEndMs: run.windowEndMs,
    })
    if (res.admitted) {
      run.pending.splice(i, 1)
      await cb.dispatch(item)
    } else {
      if (res.sleepUntil !== undefined && (earliestWake === undefined || res.sleepUntil < earliestWake))
        earliestWake = res.sleepUntil
      i++ // leave queued; try a cheaper task behind it
    }
  }
  return earliestWake
}

/** Stamp every still-queued task SKIPPED(capacity) with its numbers (§9f). */
async function starveAll(
  ledger: CapacityLedger,
  run: AdmissionRun,
  cb: AdmissionCallbacks,
  now: number,
): Promise<void> {
  const items = run.pending.splice(0, run.pending.length)
  for (const item of items) {
    const estimate = item.estimateTokens ?? ledger.defaultEstimate
    const ctx = { project: run.project, runId: run.runId, taskId: item.id }
    const reason = ledger.starve(ctx, run.candidateProfiles, estimate, { now, windowEndMs: run.windowEndMs })
    await cb.starveCard(item, reason)
  }
}
