import { isStatusSuperseded } from '@/lib/status-style'
import type { Conversation } from '@/lib/types'

/**
 * PULSE — the fleet grouped by ACTIVITY rather than by project.
 *
 * Six bands in a FIXED reading order. The order never changes with the data:
 * muscle memory is the whole point of a glanceable surface, so a band with zero
 * rows collapses but never moves.
 *
 *   blocked  a human is the only thing that can move this — un-fakeable
 *   working  active and streaming right now
 *   done     finished inside JUST_DONE_WINDOW_MS, still worth a look
 *   needs    the agent SAYS it wants you — self-reported, over-reported
 *   idle     alive, quiet, nobody waiting
 *   expired  ended/reaped and past the window — collapsed to a count
 *
 * BLOCKED LEADS, then WORKING, then JUST DONE, then NEEDS YOU. Three orderings
 * have been tried and the first two lost to real fleet data:
 *
 *  - needs-first (original) buried the twelve things actually running under
 *    thirty-two that mostly were not blocked. `needs_you` is over-reported --
 *    agents raise it for "here is my result, what next?" as readily as for a
 *    genuine block.
 *  - working -> needs -> done (2026-08-18) fixed that but pushed JUST DONE below
 *    a needs band that routinely runs 30+ rows, i.e. off the screen entirely.
 *    A finished run is the most perishable thing on the board: it is where you
 *    merge, ship, or catch a bad landing, and its window is only
 *    JUST_DONE_WINDOW_MS wide. Missing it costs more than reading a stale ask
 *    late.
 *  - Both of those left the genuinely BLOCKED sorted by age against thirty soft
 *    asks. On 2026-08-19 a dialog sat open and unanswered for twelve minutes
 *    inside a fleet of ~100 conversations with nothing on any surface saying so.
 *    A hard block is small, un-fakeable and total -- the agent is stopped until
 *    a human acts -- so it now leads the board.
 *
 * So the top of the board is what is STUCK on you (blocked), what MOVED
 * (working) and what just STOPPED moving (done) -- all small, all perishable.
 * The long over-reported queue sits beneath them where its length hurts nobody.
 */
export type PulseBand = 'blocked' | 'needs' | 'working' | 'done' | 'idle' | 'expired'

/** Fixed reading order. Never sort this by count. */
export const PULSE_BANDS: readonly PulseBand[] = ['blocked', 'working', 'done', 'needs', 'idle', 'expired'] as const

/** The two bands that mean "a human is wanted". Every surface that escalates --
 *  card treatment, pulsing dot, the highlighted lead row -- keys off this rather
 *  than naming a band, so `blocked` can never be added to one surface and
 *  forgotten on another. */
const ATTENTION_BANDS: ReadonlySet<PulseBand> = new Set<PulseBand>(['blocked', 'needs'])

export function isAttentionBand(band: PulseBand): boolean {
  return ATTENTION_BANDS.has(band)
}

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

function isHardBlocked(c: Conversation, flags: PulseAttentionFlags = {}): boolean {
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

/** Has this conversation reported a terminal `done` that is still fresh? */
function isFreshlyDone(c: Conversation, now: number): boolean {
  if (c.liveStatus?.state !== 'done') return false
  if (isStatusSuperseded(c.liveStatus, c.lastInputAt)) return false
  return now - c.lastActivity <= JUST_DONE_WINDOW_MS
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
 */
function isWorking(c: Conversation, now: number): boolean {
  if (LIVE_STATUSES.has(c.status)) return true
  if (c.liveStatus?.state !== 'working') return false
  return now - c.lastActivity <= JUST_DONE_WINDOW_MS
}

/**
 * Assign one conversation to exactly one band.
 *
 * Precedence is strict and matches the display order at the top:
 *   death > hard block > liveness > recency > soft ask
 * A conversation that is both `active` and parked on a dialog belongs in
 * BLOCKED, not WORKING -- but one that has ENDED belongs nowhere near it.
 */
export function bandOf(c: Conversation, flags: PulseAttentionFlags = {}, now: number = Date.now()): PulseBand {
  // DEATH OUTRANKS ATTENTION, and it has to be checked FIRST.
  //
  // A conversation that has ENDED cannot want anything: there is no process
  // left to answer, so its last self-report is a fossil rather than a request.
  // This used to be checked after `wantsAttention`, which meant an agent whose
  // final act was `needs_you` parked itself at the top of NEEDS YOU forever --
  // unanswerable, unclearable, and pushing live work down the page.
  if (c.status === 'ended') {
    // Recently ended is still worth a glance; past the window it drops out of
    // sight entirely.
    return now - c.lastActivity <= JUST_DONE_WINDOW_MS ? 'done' : 'expired'
  }

  if (isHardBlocked(c, flags)) return 'blocked'

  if (wantsAttention(c, flags)) return 'needs'

  if (isFreshlyDone(c, now)) return 'done'
  if (isWorking(c, now)) return 'working'
  return 'idle'
}

/**
 * Sort key within a band.
 *
 * BLOCKED and NEEDS YOU sort OLDEST FIRST — the request that has been rotting
 * longest is the most urgent, and it is what the surface preselects. Every other
 * band sorts freshest first, which is what "what just happened" means.
 */
export function compareInBand(band: PulseBand, a: Conversation, b: Conversation): number {
  const oldestFirst = band === 'needs' || band === 'blocked'
  return oldestFirst ? a.lastActivity - b.lastActivity : b.lastActivity - a.lastActivity
}
