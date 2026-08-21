/**
 * THE SEAT LEASE -- one writer per `(epic, card, role)`, claimed by the seat
 * itself at the moment it connects.
 *
 * WHY THIS EXISTS BESIDE THE DISPATCH GUARD. The engine's guards -- `inFlight`,
 * `inVerify`, the just-dispatched pending set -- are all guesses made by the
 * party that is NOT holding the worktree: the broker reasons from a conversation
 * registry it knows is behind, plus a log. Every guard of that shape is wrong at
 * exactly the moment its inputs are stale, which is the same moment a duplicate
 * happens. `inFlight` was such a guard. `inVerify` was such a guard. Both were
 * correct code and both were bypassed on 2026-08-21 by the same stale input.
 *
 * A lease claimed by the seat is a different kind of thing. It is checked at the
 * point of use, by the process that will do the writing, at the moment it starts
 * writing. It does not care WHY a second seat exists -- registry lag, an `open`
 * lane that never moved, a manual dispatch, a sweep race, a broker restart
 * replaying something, or a cause nobody has diagnosed yet. Any second writer
 * loses. That is the difference between closing a bug and closing a class, and
 * this class is the one whose failure is SILENT: two implementers on one card
 * share ONE worktree (`cardBranch` derives the name from the card), so the
 * loser's work is staged into the winner's commit with no conflict.
 *
 * IT IS A MUTEX BETWEEN SEATS, NEVER AN AUTHORISATION GATE. A seat that cannot
 * reach the broker at all must still be able to work -- see the MCP tool, which
 * proceeds on a transport failure and lets the dispatch guard above be the
 * protection for that beat. A lease that becomes a precondition for working is a
 * new way for the whole engine to stop.
 *
 * NO SECOND LEASE. Every decision here is `evaluateLease` from epic-lease.ts:
 * the CAS, holder identity, the generation, `LEASE_STALE_MS`, and a liveness
 * question asked of the registry rather than of the claimant were all argued out
 * once. This module contributes exactly two things the epic scope does not need
 * -- the frontmatter key per role, and the words the baton and the losing seat
 * are told.
 */

import type { EpicLease } from './epic-lease'
import type { EpicRole } from './epic-run-types'

/** The claim key. ROLE IS PART OF IT and that is not optional: an implementer
 *  and a verifier on the same card are two legitimate concurrent seats -- the
 *  whole reason `inVerify` is a separate lane from `inFlight`. Only a same-role
 *  collision is a collision. */
export interface SeatLeaseKey {
  epicId: string
  cardId: string
  role: EpicRole
}

/**
 * The frontmatter key prefix a role's grip is written under, on the CARD's own
 * file: `seat_implementer`, `seat_implementer_gen`, `seat_implementer_at`.
 *
 * On the CARD rather than in the run artifact, for the reason the overseer lease
 * lives on the epic card: a wedged seat should be visible and breakable by a
 * human reading the board, without knowing that `.rclaude/project/epics/`
 * exists. And per ROLE rather than one `seat:` key, because two keys is what
 * makes "an implementer and a verifier may both hold this card" a fact about
 * storage instead of a rule some later reader can talk themselves out of.
 */
export function seatLeaseKeyPrefix(role: EpicRole): string {
  return `seat_${role}`
}

/** A seat named by all three parts of its key -- what a log line points at. */
export function seatSlug(key: SeatLeaseKey): string {
  return `${key.epicId}/${key.cardId}/${key.role}`
}

/** Enough of a conversation id to identify it in prose, matching what
 *  `evaluateLease` puts in its own refusal reasons. */
function short(convId: string): string {
  return convId.slice(0, 8)
}

/** What happened to one claim. `broke` is a GRANT that displaced somebody -- a
 *  collision that was resolved, which is still a collision and still worth a
 *  line in the baton. */
export type SeatClaimOutcome = 'granted' | 'broke' | 'refused'

export interface SeatClaimAudit {
  key: SeatLeaseKey
  /** The claimant. */
  convId: string
  outcome: SeatClaimOutcome
  /** The other conversation: who refused this claim, or who this claim
   *  displaced. Absent only on an uncontested `granted`. */
  holder?: EpicLease
  /** The CAS's own words, when it refused. */
  reason?: string
}

/**
 * The baton line for one claim -- ALWAYS WRITTEN, whichever way it went.
 *
 * A belt that fires invisibly teaches nobody that the guard above it has a hole.
 * `runner-queue-verb-q1` is the shape being imitated: the duplicate seat that
 * reported itself is the only reason there is a diagnosis of the 2026-08-21 pair
 * at all. So the refusal names BOTH conversations and the run's own log carries
 * the evidence that a second seat existed.
 */
export function seatClaimBaton(audit: SeatClaimAudit): string {
  const who = `\`${audit.convId}\``
  const seat = `${audit.key.role} seat on \`${audit.key.cardId}\``
  if (audit.outcome === 'refused') {
    const holder = audit.holder?.convId ? `\`${audit.holder.convId}\`` : 'a holder it could not name'
    const since = audit.holder?.at ? `, held since ${audit.holder.at}` : ''
    return (
      `SEAT LEASE REFUSED: ${who} asked for the ${seat} and lost to ${holder}${since}. ` +
      `${audit.reason ?? 'no reason given'}. The loser is exiting; the holder keeps the card. ` +
      'TWO SEATS EXISTED FOR ONE CARD -- the guard above this belt has a hole.'
    )
  }
  if (audit.outcome === 'broke') {
    const holder = audit.holder?.convId ? `\`${audit.holder.convId}\`` : 'an unnamed holder'
    const since = audit.holder?.at ? ` (taken ${audit.holder.at})` : ''
    return (
      `SEAT LEASE TAKEN OVER: ${who} claimed the ${seat}, displacing ${holder}${since}. ` +
      'The previous holder was dead or wedged past the stale window.'
    )
  }
  return `SEAT LEASE TAKEN: ${who} holds the ${seat}.`
}

/**
 * THE ORDER, as a seat's prompt carries it -- one block, both seats.
 *
 * Written once here rather than twice in the two prompt builders because the
 * three answers have to be spelled out identically. A worker told only "claim
 * your seat" will treat UNREACHABLE as a failure and stop, which converts the
 * mutex into exactly the engine-wide halt it must never be.
 *
 * FIRST, before reading the card and before touching git, because the point of
 * the claim is to happen before there is anything to corrupt.
 */
export function seatClaimOrder(role: EpicRole, cardId: string): string {
  return [
    'CLAIM YOUR SEAT FIRST -- before you read the card, before you touch git:',
    '',
    '    epic_seat(action="claim")',
    '',
    `It takes no arguments: which epic, card and role you hold is read from the way you were launched. Three`,
    'answers, and they are not interchangeable:',
    '',
    `  GRANTED      you hold the ${role} seat on \`${cardId}\`. Work.`,
    '  REFUSED      another live conversation already holds this exact seat. The call ENDS your conversation,',
    '               and that is correct: you share ONE worktree with the holder -- the branch is derived from',
    '               the card id -- so anything you wrote would be staged into their commit with no conflict and',
    '               no signal. Do not argue with it, do not retry, do not "just check something first".',
    '  UNREACHABLE  the broker or sentinel could not answer. PROCEED WITH YOUR WORK and note it in your card',
    '               body. The lease is a mutex between seats, never permission to work.',
    '',
    'An implementer and a verifier on the same card are two DIFFERENT seats and both are granted. Only a',
    'same-role collision is a collision.',
  ].join('\n')
}

/** The other end of the order: give the seat back when the work is finished, so
 *  a re-dispatch can start at once instead of waiting out the stale window. */
export const SEAT_RELEASE_ORDER =
  'epic_seat(action="release") -- give the seat back, so the card can be dispatched again immediately ' +
  'instead of after the stale window.'

/**
 * What the LOSING seat is told, before it exits.
 *
 * It says STOP rather than "try again later" on purpose: a retry is a second
 * writer arriving a minute later, which is the same corruption with a longer
 * fuse. The card belongs to the holder until the holder is gone, and when it IS
 * gone the engine dispatches a fresh seat through the normal path.
 */
export function seatRefusalNotice(key: SeatLeaseKey, convId: string, holder: EpicLease, reason: string): string {
  return [
    `SEAT LEASE REFUSED for \`${key.cardId}\` (${key.role}).`,
    '',
    `Conversation \`${holder.convId}\` already holds this seat${holder.at ? ` (since ${holder.at})` : ''}.`,
    `You are \`${convId}\`. The lease says: ${reason}`,
    '',
    'You and the holder share ONE worktree -- the branch is derived from the card id -- so anything you write',
    "would be staged into the holder's commit with no conflict and no signal. That is the corruption this",
    'lease exists to prevent.',
    '',
    'STOP NOW. Do not edit anything, do not commit, do not retry, and do not move the card. The refusal is',
    'already recorded in the epic baton naming both conversations. Exit.',
  ]
    .join('\n')
    .concat(`\n\nSeat: ${seatSlug(key)}`)
}
