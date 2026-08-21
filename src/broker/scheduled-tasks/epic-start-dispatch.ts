/**
 * ARMING AN EPIC ON A CLOCK -- the broker half of an `epic-start` schedule.
 *
 * A schedule with `action: 'epic-start'` launches no conversation. It arms one
 * epic run through `armEpicRun` -- the SAME function the RUN button and the
 * `epic_run action=start` tool go through -- and the epic engine's own beat does
 * every dispatch from there. So this module is small on purpose: it translates
 * the schedule's stored payload into the arm's, and gets out of the way.
 *
 * IT RETURNS A `DispatchOutcome` so `fire.ts` treats an arm exactly like a spawn
 * for everything that is not the work itself: the owner re-check, the overlap
 * rule, seat admission, the run row, the failure backoff that disarms a schedule
 * nobody is fixing. Those are rules about firing unattended work, and none of
 * them is a rule about spawning.
 */

import type { ScheduledTask, ScheduleEpicStart } from '../../shared/scheduled-task'
import type { DispatchOutcome } from './fire'

export interface EpicStartDispatchDeps {
  /** Arm one run. Mirrors `armEpicRun`, which is what wires to it. */
  arm(project: string, epicId: string, start: Record<string, unknown>): Promise<{ ok: boolean; error?: string }>
}

/**
 * The stored payload as the sentinel's `EpicStartInput`.
 *
 * `when` becomes `cadence` HERE and only here, which is the same translation
 * `epic_run`'s `toBody` does at its own seam: `when` is what the tool, the card
 * and this schedule call the axis, `cadence` is what the run file stores.
 *
 * Every key is omitted when unset rather than sent as `undefined`, because the
 * sentinel's `start` MERGES -- an explicit key is how a resume clobbers a knob a
 * human raised by hand, and a schedule that fires weekly would clobber it weekly.
 */
export function toStartPayload(epic: ScheduleEpicStart): Record<string, unknown> {
  const start: Record<string, unknown> = {}
  if (epic.when !== undefined) start.cadence = epic.when
  if (epic.target !== undefined) start.target = epic.target
  if (epic.concurrency !== undefined) start.concurrency = epic.concurrency
  if (epic.maxGens !== undefined) start.maxGens = epic.maxGens
  if (epic.maxUsd !== undefined) start.maxUsd = epic.maxUsd
  if (epic.maxWallClockMinutes !== undefined) start.maxWallClockMinutes = epic.maxWallClockMinutes
  return start
}

/** Arm the run this schedule names. */
export async function dispatchEpicStart(task: ScheduledTask, deps: EpicStartDispatchDeps): Promise<DispatchOutcome> {
  // Unreachable through the schema (`checkAction` refuses an `epic-start` with
  // no `epic` block at create AND at patch), and a FAILED fire rather than a
  // throw if a record from somewhere else ever gets here -- a schedule that
  // quietly does nothing is the one outcome this whole path is built against.
  if (!task.epic) return { ok: false, error: 'this epic-start schedule names no epic' }

  const result = await deps.arm(task.projectUri, task.epic.epicId, toStartPayload(task.epic))
  if (!result.ok) return { ok: false, error: result.error ?? 'arming the epic failed' }

  console.log(
    `[sched] epic-start id=${task.id} project=${task.projectUri} epic=${task.epic.epicId} ` +
      `when=${task.epic.when ?? '(unchanged)'}`,
  )
  return { ok: true }
}
