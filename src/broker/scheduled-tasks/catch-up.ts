/**
 * MISSED-FIRE RECONCILIATION -- what happens on boot after an outage.
 *
 * The broker restarts, the laptop sleeps, the container is redeployed. Schedules
 * that should have fired during the gap did not, and there are exactly three
 * honest options: pretend it never happened, replay everything, or record the gap
 * and move on. We record.
 *
 * Waking to forty queued overnight runs is worse than a gap, so the default
 * (`catchUp: 'skip'`) never re-runs -- it just writes `missed` rows so the
 * history shows the truth. `catchUp: 'once'` additionally re-runs the single most
 * recent miss, and only while it is still recent enough to be useful.
 */

import { minuteKey, wallClockParts } from '../../shared/cron-time'
import { newScheduledRunId, type ScheduledTask } from '../../shared/scheduled-task'
import type { StoreDriver } from '../store/types'
import { computeMissedFires, shouldCatchUp } from './policy'

export interface ReconcileDeps {
  store: StoreDriver
  now(): number
  /** Run the catch-up fire for a schedule. Supplied by the engine. */
  fireCatchUp(task: ScheduledTask, key: string): Promise<void>
  onRunRecorded?(scheduleId: string): void
}

/** Write one `missed` row per skipped fire so the outage is visible in history. */
function recordMissed(store: StoreDriver, task: ScheduledTask, missed: number[]): void {
  for (const firedAt of missed) {
    store.scheduledTasks.addRun({
      id: newScheduledRunId(),
      scheduleId: task.id,
      firedAt,
      minuteKey: minuteKey(wallClockParts(firedAt, task.tz), task.tz),
      trigger: 'cron',
      outcome: 'missed',
    })
  }
}

/**
 * Walk every armed schedule and settle what it missed. Called once at boot; safe
 * to call again (a schedule with no gap is a no-op).
 */
export async function reconcileMissedFires(deps: ReconcileDeps): Promise<void> {
  const nowMs = deps.now()
  for (const task of deps.store.scheduledTasks.list({ enabledOnly: true })) {
    const missed = computeMissedFires(task, nowMs)
    if (missed.length === 0) continue

    recordMissed(deps.store, task, missed)
    console.log(
      `[sched] missed id=${task.id} name="${task.name}" count=${missed.length} ` +
        `since=${new Date(task.lastRunAt ?? 0).toISOString()} catchUp=${task.catchUp}`,
    )
    deps.onRunRecorded?.(task.id)

    if (!shouldCatchUp(task, missed, nowMs)) continue
    await deps.fireCatchUp(task, minuteKey(wallClockParts(nowMs, task.tz), task.tz))
  }
}
