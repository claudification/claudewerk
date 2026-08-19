import { isStatusSuperseded } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'

/**
 * PULSE SIGNALS — the predicates a band is decided from.
 *
 * Split out of `bands.ts` so that file stays what its name says: the fixed band
 * taxonomy and the one function that maps a conversation onto it. Everything
 * here answers a single question about ONE conversation ("is a human wanted?",
 * "did this finish?", "is it moving?") and knows nothing about band order.
 */

/** How long a finished conversation stays in JUST DONE before falling to expired. */
export const JUST_DONE_WINDOW_MS = 30 * 60_000

/**
 * Store-held attention signals that live outside the Conversation record.
 *
 * The conversation card alone can't see these — they hang off the broker's
 * pending queues — so the caller passes them in rather than us reaching into
 * the store from a pure module.
 *
 * They are also the SECOND, INDEPENDENT PATH to the blocked band. The card's own
 * `pendingAttention` is a denormalized umbrella the broker maintains, and on
 * 2026-08-19 a single broker bug (`PostToolUse` clearing it 200 ms after
 * `dialog_show` set it) made an open dialog invisible on every surface at once.
 * One field must never again be the only thing standing between a stuck agent
 * and the human it is waiting for.
 */
export interface PulseAttentionFlags {
  hasPendingPermission?: boolean
  hasPendingLink?: boolean
  /** A dialog is on screen, unanswered — store `pendingDialogs` map. */
  hasOpenDialog?: boolean
  /** An AskUserQuestion is outstanding — store `pendingAskQuestions`. */
  hasPendingAsk?: boolean
}

/** Statuses that mean the agent host is up and doing something. */
const LIVE_STATUSES: ReadonlySet<Conversation['status']> = new Set(['active', 'starting', 'booting'])

/**
 * HARD BLOCK — a human is the only thing that can move this conversation.
 *
 * Every source here is un-fakeable: the agent is parked inside a tool call that
 * does not return until someone answers. That is categorically different from
 * `liveStatus.state === 'needs_you'`, which the agent writes about itself and
 * raises as readily for "here is my result, what next?" as for a real block.
 *
 * Read BOTH the card's umbrella and the store flags — see PulseAttentionFlags.
 */
export function hardBlockOf(c: Conversation, flags: PulseAttentionFlags = {}): string | undefined {
  if (flags.hasPendingPermission) return 'permission'
  if (flags.hasOpenDialog) return 'dialog'
  if (flags.hasPendingAsk) return 'ask'
  if (flags.hasPendingLink) return 'link'
  if (c.pendingSpawnApproval) return 'spawn_approval'
  if (c.pendingAttention) return c.pendingAttention.type
  return undefined
}

export function isHardBlocked(c: Conversation, flags: PulseAttentionFlags = {}): boolean {
  return hardBlockOf(c, flags) !== undefined
}

/**
 * Does this conversation want a human RIGHT NOW?
 *
 * Deliberately broad: a false negative here is a conversation silently rotting,
 * which is the exact failure Pulse exists to kill. A false positive only costs
 * one extra row in the top band.
 *
 * `superseded` matters: if the user has already typed since the agent raised its
 * hand, the request is stale and no longer wants them. That applies ONLY to the
 * self-reported half — a dialog does not stop blocking because you typed
 * something else at it.
 */
export function wantsAttention(c: Conversation, flags: PulseAttentionFlags = {}): boolean {
  if (isHardBlocked(c, flags)) return true
  const state = c.liveStatus?.state
  if (state !== 'needs_you' && state !== 'blocked') return false
  return !isStatusSuperseded(c.liveStatus, c.lastInputAt)
}

/**
 * Has this conversation reported a terminal `done` that is still fresh?
 *
 * FRESHNESS IS DATED FROM `liveStatus.updatedAt` -- the moment the agent SAID
 * done -- never from `lastActivity`, which is merely the last time the process
 * twitched. The two diverge badly, and the divergence is not an edge case:
 * `lastActivity` is stamped by the SHUTDOWN itself (the terminate forwards,
 * `SessionEnd` fires, the host socket closes), so for an ended conversation it
 * is effectively the CLOSE time. On 2026-08-19 three conversations that had
 * finished on Aug 14, 16 and 17 were closed from the context menu and all three
 * jumped straight into JUST DONE -- because closing them looked exactly like
 * finishing them. A revive does the same thing from the other direction.
 */
export function isFreshlyDone(c: Conversation, now: number): boolean {
  if (c.liveStatus?.state !== 'done') return false
  if (isStatusSuperseded(c.liveStatus, c.lastInputAt)) return false
  return now - c.liveStatus.updatedAt <= JUST_DONE_WINDOW_MS
}

/**
 * Is the agent doing something, whoever says so?
 *
 * The broker `status` only reads `active` while a turn is actually streaming, so
 * a live conversation between two tool calls reads `idle` — and used to fall to
 * the bottom band under thirty NEEDS rows, off the screen. The agent's own
 * `working` self-report covers that gap, fenced by the JUST_DONE window so a
 * week-old conversation that never got a terminal status cannot claim to be
 * running.
 *
 * Unlike `isFreshlyDone` this DOES fence on `lastActivity`, and correctly so:
 * the question here is whether the process is still twitching at all, which is
 * exactly what `lastActivity` measures.
 */
export function isWorking(c: Conversation, now: number): boolean {
  if (LIVE_STATUSES.has(c.status)) return true
  if (c.liveStatus?.state !== 'working') return false
  return now - c.lastActivity <= JUST_DONE_WINDOW_MS
}
