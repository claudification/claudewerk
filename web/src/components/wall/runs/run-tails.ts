/**
 * THE TWO TAILS a run row ends with: what it last DID (the baton) and whether it
 * is still beating (the pulse).
 *
 * Split out of `run-model.ts` when the baton clamp pushed that file past the
 * 200-line bar. It is a real seam and not just a line count: everything here is
 * about PRESENTING a log -- how many entries, how much of each one -- while what
 * is left in `run-model.ts` is about JUDGING a run (which lane, which cap, is it
 * stalled). The two get edited for different reasons.
 *
 * No React and no clock, same as its parent: every function takes what it needs
 * and returns a value, so the pane's arithmetic stays testable without a DOM.
 */

import type { EpicLogEntry } from '@shared/epic-run-types'
import type { EpicBeatRecord } from '@shared/protocol'

/**
 * How many baton entries the wall shows: ONE.
 *
 * It was three, and three was wrong. A baton body is prose an agent wrote for
 * another agent -- routinely 1-2k characters -- so three of them buried the
 * numbers this pane exists to print under a screenful of log. A7 is a SUMMARY
 * surface: seats, slots, progress, timing. The last beat's headline earns one
 * clamped line; the full log belongs in the overseer window, which shows all of
 * them and is where you go when you actually want to read.
 */
const BATON_TAIL = 1

/** The baton arrives oldest-first (it is an append-only log); a tail reads
 *  newest-first, because the last thing that happened is the interesting one. */
export function batonTail(baton: readonly EpicLogEntry[], n: number = BATON_TAIL): EpicLogEntry[] {
  return baton.slice(-n).reverse()
}

/** Hard cap on the headline. Belt-and-braces beside the CSS ellipsis, for the
 *  common case of a body that is one enormous paragraph with no newline in it at
 *  all -- these are written by a model, for a model. */
const HEADLINE_CHARS = 140

/**
 * THE FIRST LINE OF A BATON BODY, and never more than that.
 *
 * Clamping in the MARKUP and not only the stylesheet is deliberate: CSS ellipsis
 * still leaves the whole essay in the DOM, so the row's height depended on a
 * `white-space` rule surviving every future edit to this pane. It did not, and
 * A7 rendered one run as a screen of prose with the numbers scrolled off the
 * top. The full body stays reachable as the row's `title`.
 */
export function batonHeadline(body: string): string {
  const line = body.split('\n', 1)[0].trim()
  return line.length > HEADLINE_CHARS ? `${line.slice(0, HEADLINE_CHARS).trimEnd()}...` : line
}

/** Ticks in the beat pulse. Matches the approved mockup. */
const BEAT_TICKS = 12

export interface BeatTick {
  at: string
  /** Did this beat DO anything? A run that beats and never acts is still a run
   *  that is not moving, and the pulse should not pretend otherwise. */
  did: boolean
}

/** Oldest-left, newest-right -- the ring already serves newest last. */
export function beatTicks(beats: readonly EpicBeatRecord[], n: number = BEAT_TICKS): BeatTick[] {
  return beats.slice(-n).map(b => ({ at: b.at, did: b.actions > 0 }))
}
