/**
 * FIRING THE MORNING REPORT -- the broker half of a `board-sweep` schedule.
 *
 * A schedule with `action: 'board-sweep'` launches no conversation. It sends one
 * board op to the sentinel that owns the project, and the sentinel does the work
 * beside the files. So this module is small on purpose: it answers the two
 * questions only the broker can answer -- is this project opted in, and which
 * cards have a live conversation on them -- and then gets out of the way.
 *
 * IT RETURNS A `DispatchOutcome` so `fire.ts` treats a sweep exactly like a
 * spawn for everything that is not the work itself: the owner re-check, the
 * overlap rule, seat admission, the run row, the failure backoff that disarms a
 * schedule nobody is fixing. Those are rules about firing unattended work, and
 * none of them is a rule about spawning.
 */

import { cardsBeingWorked } from '../../shared/board-sweep'
import type { BoardSweepResult, Conversation } from '../../shared/protocol'
import type { ScheduledTask } from '../../shared/scheduled-task'
import type { BoardRpcResult } from '../board-rpc'
import type { IsLive } from '../werk-liveness'
import type { DispatchOutcome } from './fire'

export interface BoardSweepDispatchDeps {
  /** One board op against the sentinel that owns `project`. Never rejects. */
  callBoard(
    project: string,
    op: { op: 'sweep'; project: string; sweep: { liveCards: string[]; tz: string } },
  ): Promise<BoardRpcResult>
  getAllConversations(): Conversation[]
  isLive: IsLive
  /**
   * "This scanner just finished a pass over this project." Stamped by the
   * CALLER, never by the scanner -- three scanners each inventing their own
   * timestamp store is the drift the scanner fabric exists to end.
   */
  stampRun(project: string, at: number): void
  /**
   * "This report exists." Recorded by the CALLER, from what the sentinel
   * returned, and only ever after a sweep that came back.
   *
   * The markdown artifact beside the cards is the human's copy; this is the
   * machine-readable one the surface renders as tickable rows. Without it the
   * morning report is a file nobody can execute, because the panel has no way to
   * ask for a report that is not on its own side of the wire -- and asking the
   * sentinel to produce one on open is exactly the on-demand sweep this feature
   * refuses to do.
   */
  recordReport(project: string, tz: string, sweep: BoardSweepResult, at: number): void
  now(): number
}

/** One line of what the sweep did, for the `[sched]` log. The run row carries
 *  the outcome; this carries the evidence a human greps for at 08:00. */
function describe(sweep: BoardSweepResult): string {
  if (sweep.skipped) return `short-circuited (${sweep.idleReason ?? 'nothing moved'}); report ${sweep.reportPath}`
  return (
    `${sweep.proposals.length} proposal(s) from ${sweep.selected.length} candidate(s); ` +
    `report ${sweep.reportPath}${sweep.reportWritten ? '' : ' (left as it was)'}`
  )
}

/**
 * Run one sweep for `task`. The liveness set is computed HERE, in the process
 * that owns the conversation registry, and crosses the wire as an answer --
 * `cardsBeingWorked` is the fold's own helper, called rather than re-derived, so
 * "a card being worked is left alone" stays one rule with one implementation.
 */
export async function dispatchBoardSweep(task: ScheduledTask, deps: BoardSweepDispatchDeps): Promise<DispatchOutcome> {
  const liveCards = [...cardsBeingWorked({ getAllConversations: deps.getAllConversations, isLive: deps.isLive })]
  const result = await deps.callBoard(task.projectUri, {
    op: 'sweep',
    project: task.projectUri,
    sweep: { liveCards, tz: task.tz },
  })
  if (!result.ok) return { ok: false, error: result.error ?? 'sweep failed' }

  const sweep = result.sweep as BoardSweepResult | undefined
  // An `ok` with no payload is a sentinel too old to know the op. Reported as a
  // failed fire rather than a silent success: a schedule whose sentinel cannot
  // sweep must show up in the run history, not look like it ran every morning.
  if (!sweep) return { ok: false, error: 'sentinel returned no sweep result -- does it know the `sweep` op?' }

  // Stamped only on a pass that actually completed. "Enabled, last ran never" is
  // the shape of every engine that died quietly in this codebase, and a stamp
  // written on a failed fire would hide exactly that.
  const at = deps.now()
  deps.stampRun(task.projectUri, at)
  // Same rule, same reason: the report is recorded only for a sweep that came
  // back, so the surface can never render a brew that did not happen.
  deps.recordReport(task.projectUri, task.tz, sweep, at)
  console.log(`[sched] board-sweep id=${task.id} project=${task.projectUri} tz=${task.tz} ${describe(sweep)}`)
  return { ok: true }
}
