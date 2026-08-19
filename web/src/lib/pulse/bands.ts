import type { Conversation } from '@/lib/types'
import { isFreshlyDone, isHardBlocked, isWorking, type PulseAttentionFlags, wantsAttention } from './signals'

export { hardBlockOf, JUST_DONE_WINDOW_MS, type PulseAttentionFlags, wantsAttention } from './signals'

/**
 * PULSE — the fleet grouped by ACTIVITY rather than by project.
 *
 * Six bands in a FIXED reading order. The order never changes with the data:
 * muscle memory is the whole point of a glanceable surface, so a band with zero
 * rows collapses but never moves.
 *
 *   blocked  a human is the only thing that can move this — un-fakeable
 *   working  active and streaming right now
 *   done     the agent REPORTED done inside JUST_DONE_WINDOW_MS -- not "closed"
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
    // CLOSED IS NOT DONE. This used to band every recently-ended conversation as
    // `done`, which asserted a completion nobody had reported: kill a running
    // conversation and it claimed success on the board. JUST DONE now means one
    // thing only -- the agent reported `done` and that report is still fresh --
    // so the same `isFreshlyDone` gate applies whether the process is still
    // around or not. Everything else that ended is CLOSED and collapses into the
    // `expired` count.
    return isFreshlyDone(c, now) ? 'done' : 'expired'
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
