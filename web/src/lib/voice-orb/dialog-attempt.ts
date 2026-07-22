/**
 * The orb's PENDING ATTEMPT: the one question it has actually read out loud and
 * is waiting on an answer for.
 *
 * A module singleton, like orb-channel-bus, because two places need the same
 * fact and neither owns the other: the announcer sets it, and `answer_dialog`
 * reads it to make sure a spoken answer lands on the question that was ASKED.
 *
 * This is the half of the cancel rule that speech cannot see: when the user
 * answers on screen instead, the question disappears from the store, the
 * attempt is dropped here, and a late "yeah, the second one" then submits
 * NOTHING rather than being re-aimed at whatever else happens to be open.
 */

export interface DialogAttempt {
  key: string
  conversationId: string
}

let attempt: DialogAttempt | null = null

export function getDialogAttempt(): DialogAttempt | null {
  return attempt
}

export function setDialogAttempt(next: DialogAttempt | null): void {
  attempt = next
}

/** Drop the attempt if it is the given question (answered, withdrawn, or gone). */
export function clearDialogAttempt(key: string): void {
  if (attempt?.key === key) attempt = null
}
