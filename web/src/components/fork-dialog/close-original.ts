/**
 * "Close the original conversation" -- offer + default.
 *
 * A fork MOVES the work: the fork resumes the folded transcript and the source
 * is left behind as a dead twin nobody reads. So closing it is the default, and
 * the ONLY thing that turns that default off is KNOWN recent activity -- proof
 * somebody (or the agent) is still using the conversation right now.
 *
 * "Unknown" is not "recent": a conversation with no usable timestamp defaults to
 * being closed. That direction is the recoverable one -- a wrongly-closed
 * conversation revives, a wrongly-kept one just rots in the sidebar.
 */

import type { Conversation } from '@/lib/types'

/** How fresh activity has to be to count as "someone is still in here". */
const ACTIVITY_WINDOW_MS = 30 * 60_000

/** Statuses that mean the conversation is doing something RIGHT NOW, whatever
 *  the timestamps say. `idle` is deliberately absent -- idle is the normal
 *  resting state of a conversation nobody has touched in hours. */
const LIVE_STATUSES = new Set<Conversation['status']>(['active', 'booting', 'starting'])

/** An already-ended conversation has nothing left to close -- no checkbox. */
export function canCloseOriginal(conversation: Conversation | undefined): conversation is Conversation {
  return !!conversation && conversation.status !== 'ended'
}

/** Newest signal that a HUMAN or the agent actually did something. */
export function lastActivityAt(conversation: Conversation): number {
  return Math.max(conversation.lastActivity ?? 0, conversation.lastInputAt ?? 0, conversation.lastTurnEndedAt ?? 0)
}

export function hasRecentActivity(conversation: Conversation, now: number = Date.now()): boolean {
  if (LIVE_STATUSES.has(conversation.status)) return true
  const last = lastActivityAt(conversation)
  return last > 0 && now - last < ACTIVITY_WINDOW_MS
}

/** Checked unless the conversation shows KNOWN activity inside the window. */
export function defaultCloseOriginal(conversation: Conversation | undefined, now: number = Date.now()): boolean {
  if (!canCloseOriginal(conversation)) return false
  return !hasRecentActivity(conversation, now)
}
