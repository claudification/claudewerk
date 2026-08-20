/**
 * IS THIS RUN ACTUALLY RUNNING? -- one answer, shared by every surface.
 *
 * `EpicRunSnapshot.status` is an INTENT, not a liveness: the sentinel writes
 * `running` when a lease is granted and nothing ever writes it back down. So a
 * run whose overseer died, whose registry entry a broker restart forgot, and
 * whose seats have all ended still reads `running` forever -- which is exactly
 * what three separate surfaces printed on 2026-08-20 while `epic-the-wall-ii`
 * spawned nothing for hours. The complaint that opened this file, verbatim:
 * "double check the overseer; that the status is TRUE and not a lie. I don't
 * see a running conversation for example."
 *
 * The fix is not a better badge in one place. It is ONE derivation, here, that
 * the header badge, the wall's A7 pane and the overseer window all read -- so a
 * fourth surface cannot invent a fourth opinion.
 *
 * ZERO RUNTIME IMPORTS ON PURPOSE. This is bundled into the control panel, and
 * the neighbouring epic modules reach `node:path` through `epic-paths.ts`. Types
 * erase; anything else here would drag node into the browser.
 */

import type { EpicActivityEntry } from './protocol'

/**
 * Two sweep ticks. Past this a run is not "beating slowly", it is stalled.
 *
 * THE NUMBER LIVES HERE because three surfaces need it and one of them is the
 * browser: the broker computes `stale` for the activity feed, while a client
 * holding an `inspect` result has the beat ring and must reach the same verdict.
 * Two copies of a threshold is two surfaces that disagree about when a run died.
 */
export const STALE_BEAT_MS = 90_000

/** Has the sweep gone quiet? `null` (never beaten) is NOT stale on its own --
 *  `runVitality` decides what a never-beaten run means, since that depends on
 *  whether anything is armed to pick it up. */
export function beatStale(lastBeatAt: string | null, nowMs: number): boolean {
  if (!lastBeatAt) return false
  const at = Date.parse(lastBeatAt)
  return Number.isFinite(at) && nowMs - at > STALE_BEAT_MS
}

/**
 * What a run is DOING, as opposed to what its status field claims.
 *
 * `working` is deliberately the narrow one: it requires a seat. A run that is
 * armed, beating, and dispatching nobody is `idle` -- true, unalarming, and the
 * distinction the old single `RUNNING` erased.
 */
export type RunVitality = 'working' | 'idle' | 'stalled' | 'paused' | 'done' | 'aborted' | 'unknown'

export interface RunVitalityView {
  vitality: RunVitality
  /** The badge word. Uppercase because every surface renders it that way. */
  label: string
  /** One sentence a human can act on. Goes in tooltips and detail panes. */
  why: string
  /** Is the engine supposed to be beating this run? Terminal runs are not. */
  live: boolean
  /** May a surface animate for this run? Only actual work breathes. */
  breathing: boolean
}

/** Everything the derivation needs. A subset of `EpicActivityEntry` so a caller
 *  holding an inspect result can answer the same question without inventing a
 *  feed row. */
export interface RunVitalityInput {
  status: EpicActivityEntry['status']
  /** Seats (implementers + verifiers) alive right now. */
  inFlight: number
  overseerAlive: boolean
  /** In the sweep's armed set. FALSE after a broker restart forgets a run. */
  armed: boolean
  lastBeatAt: string | null
  /** The broker's own two-tick staleness call, taken verbatim so no surface
   *  invents a second threshold. */
  stale: boolean
}

const TERMINAL: Partial<Record<string, RunVitalityView>> = {
  complete: {
    vitality: 'done',
    label: 'DONE',
    why: 'Every card under this epic is terminal. The run finished.',
    live: false,
    breathing: false,
  },
  aborted: {
    vitality: 'aborted',
    label: 'ABORTED',
    why: 'This run was aborted. It will not beat again unless it is re-armed.',
    live: false,
    breathing: false,
  },
  paused: {
    vitality: 'paused',
    label: 'PAUSED',
    why: 'Paused. Nothing dispatches until RESUME re-arms it.',
    live: false,
    breathing: false,
  },
}

const UNKNOWN: RunVitalityView = {
  vitality: 'unknown',
  label: 'NO RUN',
  why: 'No run artifact could be read for this epic.',
  live: false,
  breathing: false,
}

const view = (
  vitality: RunVitality,
  label: string,
  why: string,
  over: Partial<RunVitalityView> = {},
): RunVitalityView => ({ vitality, label, why, live: true, breathing: false, ...over })

/** A stamp that does not parse is NOT a beat. Reading it as one would date the
 *  run to the epoch or to now, and both of those are answers we would print. */
function hasBeaten(lastBeatAt: string | null): boolean {
  return lastBeatAt !== null && Number.isFinite(Date.parse(lastBeatAt))
}

/** The stalled sentence, which is worth more when it can name open seats: a
 *  quiet sweep with nobody out is a dead engine, one with seats still open is a
 *  fleet nobody is supervising. */
function quietWhy(seats: number): string {
  const open = seats > 0 ? `, with ${seats} seat(s) still open` : ''
  return `The sweep has gone quiet -- nothing has beaten in over 90s${open}.`
}

/** Beating, nobody working. The two flavours differ by whether the sweep will
 *  keep coming back on its own. */
function idleWhy(armed: boolean): string {
  return armed
    ? 'The engine is beating but no seat is working -- nothing was dispatchable this generation.'
    : 'Beating, but not in the sweep armed set (a broker restart forgets that) and no seat is working.'
}

/**
 * The ways a live-status run can fail to be running, in the order they matter.
 * Split from `runVitality` so the terminal cases above stay a lookup and this
 * stays the actual reasoning.
 */
function liveVitality(input: RunVitalityInput): RunVitalityView {
  const beaten = hasBeaten(input.lastBeatAt)

  // Never beaten AND not in the armed set: nothing will ever pick it up. This is
  // the 2026-08-18 shape -- a run that looks fine and is not running.
  if (!beaten && !input.armed) {
    return view('stalled', 'STALLED', 'Not in the sweep armed set and it has never beaten. RESUME re-arms it.')
  }
  if (input.stale) {
    return view('stalled', 'STALLED', quietWhy(input.inFlight + (input.overseerAlive ? 1 : 0)))
  }
  if (input.inFlight > 0) {
    return view('working', 'RUNNING', `${input.inFlight} seat(s) working.`, { breathing: true })
  }
  if (input.overseerAlive) {
    return view('working', 'RUNNING', 'The overseer is awake; no implementer or verifier is out yet.', {
      breathing: true,
    })
  }
  if (!beaten) {
    return view('idle', 'ARMED', 'Armed and waiting for its first beat (the sweep runs every 45s).')
  }
  return view('idle', 'IDLE', idleWhy(input.armed))
}

/** THE answer. Terminal status wins over everything -- a late settle must never
 *  make an aborted run look alive again. */
export function runVitality(input: RunVitalityInput): RunVitalityView {
  if (input.status === null) return UNKNOWN
  return TERMINAL[input.status] ?? liveVitality(input)
}

/** Would the engine beat this run at all? Terminal runs stay VISIBLE everywhere
 *  -- a finished run is exactly the one you want to read -- but they are not
 *  counted as live and never animate. */
export function isVitallyLive(entry: RunVitalityInput): boolean {
  return runVitality(entry).live
}
