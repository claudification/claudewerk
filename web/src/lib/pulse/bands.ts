import { isStatusSuperseded } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'

/**
 * PULSE — the fleet grouped by ACTIVITY rather than by project.
 *
 * Five bands in a FIXED reading order. The order never changes with the data:
 * muscle memory is the whole point of a glanceable surface, so a band with zero
 * rows collapses but never moves.
 *
 *   needs    something wants a human — permission, question, dialog, blocked
 *   working  active and streaming right now
 *   done     finished inside JUST_DONE_WINDOW_MS, still worth a look
 *   idle     alive, quiet, nobody waiting
 *   expired  ended/reaped and past the window — collapsed to a count
 */
export type PulseBand = 'needs' | 'working' | 'done' | 'idle' | 'expired'

/** Fixed reading order. Never sort this by count. */
export const PULSE_BANDS: readonly PulseBand[] = ['needs', 'working', 'done', 'idle', 'expired'] as const

/** How long a finished conversation stays in JUST DONE before falling to expired. */
export const JUST_DONE_WINDOW_MS = 30 * 60_000

/** Store-held attention signals that live outside the Conversation record.
 *  The conversation card alone can't see these — they hang off the broker's
 *  pending queues — so the caller passes them in rather than us reaching into
 *  the store from a pure module. */
export interface PulseAttentionFlags {
  hasPendingPermission?: boolean
  hasPendingLink?: boolean
}

/** Statuses that mean the agent host is up and doing something. */
const LIVE_STATUSES: ReadonlySet<Conversation['status']> = new Set(['active', 'starting', 'booting'])

/**
 * Does this conversation want a human RIGHT NOW?
 *
 * Deliberately broad: a false negative here is a conversation silently rotting,
 * which is the exact failure Pulse exists to kill. A false positive only costs
 * one extra row in the top band.
 *
 * `superseded` matters: if the user has already typed since the agent raised its
 * hand, the request is stale and no longer wants them.
 */
export function wantsAttention(c: Conversation, flags: PulseAttentionFlags = {}): boolean {
  if (flags.hasPendingPermission || flags.hasPendingLink) return true
  if (c.pendingAttention) return true
  if (c.pendingSpawnApproval) return true
  const state = c.liveStatus?.state
  if (state !== 'needs_you' && state !== 'blocked') return false
  return !isStatusSuperseded(c.liveStatus, c.lastInputAt)
}

/** Has this conversation reported a terminal `done` that is still fresh? */
function isFreshlyDone(c: Conversation, now: number): boolean {
  if (c.liveStatus?.state !== 'done') return false
  if (isStatusSuperseded(c.liveStatus, c.lastInputAt)) return false
  return now - c.lastActivity <= JUST_DONE_WINDOW_MS
}

/**
 * Assign one conversation to exactly one band.
 *
 * Precedence is strict and NOT the same as the display order: attention beats
 * liveness beats recency. A conversation that is both `active` and asking a
 * question belongs in NEEDS YOU, not WORKING.
 */
export function bandOf(c: Conversation, flags: PulseAttentionFlags = {}, now: number = Date.now()): PulseBand {
  if (wantsAttention(c, flags)) return 'needs'

  if (c.status === 'ended') {
    // A conversation that ended recently is still worth a glance; past the
    // window it drops out of sight entirely.
    return now - c.lastActivity <= JUST_DONE_WINDOW_MS ? 'done' : 'expired'
  }

  if (isFreshlyDone(c, now)) return 'done'
  if (LIVE_STATUSES.has(c.status)) return 'working'
  return 'idle'
}

/**
 * Sort key within a band.
 *
 * NEEDS YOU sorts OLDEST FIRST — the request that has been rotting longest is
 * the most urgent, and it is what the surface preselects. Every other band
 * sorts freshest first, which is what "what just happened" means.
 */
export function compareInBand(band: PulseBand, a: Conversation, b: Conversation): number {
  return band === 'needs' ? a.lastActivity - b.lastActivity : b.lastActivity - a.lastActivity
}
