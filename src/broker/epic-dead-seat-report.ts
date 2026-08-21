/**
 * WHAT THE BATON SAYS WHEN A SEAT DIES INSTEAD OF FINISHING.
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  "THE WORK FINISHED" AND "THE WORKER DIED" MUST NOT READ THE SAME.        ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * Both arrive at the same lane -- `EpicGroup.settled` -- and both get exactly one
 * machine `completion` entry, and they MUST: the `completion` kind is what
 * `acknowledgedCardIds` folds, what `pendingSeatCards` treats as resolving, and
 * what `appendEpicLog` deduplicates at most once per card. Inventing a new kind
 * for a death would drop the card out of all three and settle it forever.
 *
 * So the KIND stays and the BODY carries the difference, because the body is what
 * an overseer actually reads. The two outcomes want opposite next moves: a clean
 * completion invites a verifier, a death invites somebody to go and look at what
 * the corpse left behind.
 *
 * THE DIRT IS THE POINT OF THE SECOND HALF. On 2026-08-21 the seat that vanished
 * had committed its implementation as `adb50250` and then written 392 lines of
 * finished tests and ENDED WITHOUT STAGING THEM. The board said `open`, the baton
 * said nothing, and the work was found only because a human ran `git status` in a
 * worktree for a card the board called unworked. Naming the branch and the dirt
 * in the entry is what stops the next generation having to go looking by hand.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: commit anything. Whether a dead seat's
 * uncommitted work is finished is a judgement, and a judgement belongs to the
 * overseer, never to a sweep. The engine's whole job here is to make the dirt
 * VISIBLE and to stop paying a concurrency slot for a corpse.
 *
 * PURE. Every sentence below is built from data and returned as a string; the
 * appends live in `epic-beat-actions.ts`. That split is what lets the exact
 * wording -- which is the deliverable, since the wording IS the signal -- be
 * asserted without a sentinel, a baton file or a beat.
 */

import type { TaskStatus } from '../shared/task-statuses'
import type { AbandonedSeat } from './epic-sweep'
import type { GitDirt } from './epic-types'

/** The ordinary settle: every backing conversation ended, and one of them
 *  produced something. Unchanged wording -- the whole baton back to 2026-08-18
 *  reads this way and a reader should not have to learn two spellings of the
 *  normal case. */
export function completionBody(cardId: string): string {
  return (
    `Card \`${cardId}\` settled: every backing conversation has ended. ` +
    'Read the card for what it claims and its gate evidence for what it proved.'
  )
}

export interface DeathReportInput {
  seat: AbandonedSeat
  /** The card's lane at the moment its seat was reaped. `undefined` when the
   *  board read did not carry the card at all, which is itself worth saying. */
  lane: TaskStatus | undefined
  /** `worktree-epic/<epic>/<card>` -- the branch the seat was given. */
  branch: string
  /** The project's uncommitted state, or the reason there is none. */
  dirt: GitDirt | null
}

/** Whole minutes, floored, because the claim is "at least this long" and a
 *  rounded-up figure would overstate the engine's own patience. */
function minutes(ms: number): number {
  return Math.floor(ms / 60_000)
}

/**
 * THE DIRT SENTENCE, and its three cases are three different facts.
 *
 * `null` dirt means the engine never asked (no `gitDirt` wired). A branch absent
 * from `known` means the scan RAN and did not see the branch at all -- a worktree
 * that was never made, or one already removed. Neither is "clean", and reporting
 * either as clean would be the engine certifying a directory nothing opened.
 */
export function dirtSentence(branch: string, dirt: GitDirt | null): string {
  if (!dirt) {
    return (
      `Whether \`${branch}\` has uncommitted work is UNKNOWN -- this broker has no way to read the ` +
      "project's git state. Check the worktree by hand before dispatching anything else at this card."
    )
  }
  if (!dirt.ok) {
    return (
      `Whether \`${branch}\` has uncommitted work is UNKNOWN -- the git scan failed (${dirt.error}). ` +
      'Check the worktree by hand before dispatching anything else at this card.'
    )
  }
  if (dirt.dirty.has(branch)) {
    return (
      `\`${branch}\` HAS UNCOMMITTED CHANGES. The dead seat left work on disk that no commit carries, and ` +
      'nothing has been committed on its behalf -- deciding whether that work is finished is the ' +
      "OVERSEER'S call, not a sweep's. Read the worktree before dispatching anything else at this card."
    )
  }
  if (!dirt.known.has(branch)) {
    return (
      `The git scan saw no branch \`${branch}\` at all, so the seat either never made its worktree or it ` +
      'has already been removed. That is not the same as clean -- nothing was looked at.'
    )
  }
  return `\`${branch}\` has no uncommitted changes; whatever the seat did is either committed or was never written.`
}

/** How the card's own lane reads, which is the fact that made this failure
 *  invisible: a seat that dies before moving its card leaves the board claiming
 *  nobody ever worked it. */
function laneSentence(cardId: string, lane: TaskStatus | undefined): string {
  if (!lane) return `The board read for this beat did not carry \`${cardId}\` at all.`
  if (lane === 'open' || lane === 'inbox') {
    return (
      `The card is still at \`${lane}\` -- the seat died before moving it, so the board claims nobody has ` +
      'ever worked it.'
    )
  }
  return `The card is at \`${lane}\`.`
}

/**
 * The `completion` body for a card whose seat was REAPED.
 *
 * Leads with the distinguishing fact in capitals rather than burying it, because
 * the overseer prompt carries a 20-entry baton tail and the first clause is the
 * part that survives being skimmed.
 */
export function deathBody(input: DeathReportInput): string {
  const { seat, branch, lane, dirt } = input
  return (
    `Card \`${seat.cardId}\` settled BECAUSE ITS SEAT DIED, not because the work finished. ` +
    `The ${seat.role} dispatched at generation ${seat.gen} (conversation \`${seat.convId}\`) held no ` +
    `connection and had said nothing for ${minutes(seat.silentForMs)} minute(s), while the registry still ` +
    `carried it as \`${seat.status}\` -- so the engine had been holding a concurrency slot for a seat that ` +
    'was already gone. THE SLOT IS NOW RELEASED. ' +
    `${laneSentence(seat.cardId, lane)} ` +
    `${dirtSentence(branch, dirt)} ` +
    'NOBODY WROTE A VERDICT: this is not a completion, and the card has had no independent judgement.'
  )
}

/** The broker-log line for the same event. Shorter, because a log reader is
 *  grepping rather than deciding -- but it names the conversation, since that is
 *  the only handle a human has for chasing what actually happened to it. */
export function deathLogLine(seat: AbandonedSeat): string {
  return (
    `REAPED a dead seat: ${seat.cardId}/${seat.role}@${seat.convId.slice(0, 8)} (gen ${seat.gen}) has been ` +
    `silent for ${minutes(seat.silentForMs)}m with no connection while the registry read \`${seat.status}\` ` +
    '-- its concurrency slot is released'
  )
}
