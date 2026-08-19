/**
 * A7's ARITHMETIC -- every judgement the pane makes, with no React, no fetch and
 * no clock of its own.
 *
 * NOTHING HERE RECOMPUTES THE ENGINE. The DAG lanes, the idle reason, the beat
 * ring and the lease all arrive already decided from `action=inspect`
 * (`epic-inspect-view.ts`); this file only counts what is in each lane and turns
 * three timestamps into the two sentences the pane exists to print. A second
 * implementation of "which lane is this card in" living on the client is exactly
 * how a pane starts disagreeing with the tool it claims to mirror.
 *
 * `nowMs` is a parameter everywhere for the same reason: the pane's freshness is
 * a real question (an inspect can be minutes old) and a function that reads
 * `Date.now()` for itself cannot be asked what it thought at any other moment.
 */

import type { EpicLease } from '@shared/epic-lease'
import type { EpicLogEntry } from '@shared/epic-run-types'
import type { NightshiftTaskMeta, NightshiftTaskStatus } from '@shared/nightshift-types'
import type { EpicActivityEntry, EpicBeatRecord, EpicInspectResult } from '@shared/protocol'

/** A run in one of these is one the sweep is supposed to be beating. */
export function isRunLive(entry: EpicActivityEntry): boolean {
  return entry.status === 'armed' || entry.status === 'running'
}

// ---------------------------------------------------------------------------
// THE DAG, AT A GLANCE
// ---------------------------------------------------------------------------

/** The six buckets the card names, in the order it names them. `inFlight` is the
 *  REGISTRY's count (conversations actually running) while the other five are the
 *  PLAN's lanes -- they answer different questions and must not be merged. */
export interface RunBuckets {
  ready: number
  inFlight: number
  verify: number
  held: number
  deps: number
  parked: number
}

export const NO_BUCKETS: RunBuckets = { ready: 0, inFlight: 0, verify: 0, held: 0, deps: 0, parked: 0 }

export function runBuckets(data: EpicInspectResult | null): RunBuckets {
  if (!data) return NO_BUCKETS
  const plan = data.plan
  return {
    ready: plan?.dispatch.length ?? 0,
    inFlight: data.live.inFlight.length,
    verify: plan?.verify.length ?? 0,
    held: plan?.heldBack.length ?? 0,
    deps: plan?.waitingOnDeps.length ?? 0,
    parked: plan?.questions.length ?? 0,
  }
}

/**
 * WHY NOTHING IS MOVING, or null when something is.
 *
 * The broker already writes the sentence; the only decision here is WHEN it is
 * worth printing. An idle reason on a paused run is not news -- it is paused --
 * and one on a run that just dispatched three cards would be stale by the time
 * it rendered. So: armed or running, and nothing ready to go.
 */
export function idleSentence(entry: EpicActivityEntry, data: EpicInspectResult | null): string | null {
  if (!data?.plan?.idleReason || !isRunLive(entry)) return null
  return data.plan.dispatch.length > 0 ? null : data.plan.idleReason
}

// ---------------------------------------------------------------------------
// STALLED -- the bug this pane exists to kill
// ---------------------------------------------------------------------------

export interface RunStall {
  /** Render this run as STALLED, loudly. */
  stalled: boolean
  /** Age of the last beat, or null when it has never beaten. */
  sinceMs: number | null
}

/**
 * `stale` is the BROKER's call (`epic-active.ts`, two sweep ticks) and is taken
 * verbatim so every surface agrees on when a run stops looking alive.
 *
 * The one case it cannot cover is a live run that has NEVER beaten: the broker's
 * test is `lastBeatAt !== null && ...`, so an armed epic the sweep never picked
 * up reports `stale: false` forever. That is the 2026-08-18 shape exactly -- a
 * run that looks fine and is not running -- so it is stalled here.
 */
export function runStall(entry: EpicActivityEntry, nowMs: number): RunStall {
  const at = entry.lastBeatAt ? Date.parse(entry.lastBeatAt) : Number.NaN
  const sinceMs = Number.isFinite(at) ? Math.max(0, nowMs - at) : null
  if (!isRunLive(entry)) return { stalled: false, sinceMs }
  return { stalled: sinceMs === null || entry.stale, sinceMs }
}

// ---------------------------------------------------------------------------
// THE OVERSEER LEASE -- THE ALARM
// ---------------------------------------------------------------------------

/**
 * MIRRORS `LEASE_STALE_MS` in `src/shared/epic-lease.ts`, which cannot be
 * imported here: that module pulls `node:path` through `epic-paths.ts` and would
 * drag it into the browser bundle. Same number, same meaning -- a holder this old
 * is presumed dead however alive its conversation claims to be.
 */
export const LEASE_STALE_MS = 10 * 60 * 1000

export type LeaseKind =
  /** The epic has never had an overseer. */
  | 'never'
  /** One woke and released the grip cleanly. */
  | 'released'
  /** Held by a conversation that is alive and recent. */
  | 'held'
  /** Held by something dead, or held far too long. THE alarm. */
  | 'stale'

export interface LeaseState {
  kind: LeaseKind
  /** How long the current holder has held it. */
  sinceMs: number | null
  /** Short form of the holding conversation id, for the sentence. */
  holder: string
  gen: number
}

export function leaseState(lease: EpicLease | null, overseerAlive: boolean, nowMs: number): LeaseState {
  if (!lease) return { kind: 'never', sinceMs: null, holder: '', gen: 0 }

  const taken = lease.at ? Date.parse(lease.at) : Number.NaN
  const sinceMs = Number.isFinite(taken) ? Math.max(0, nowMs - taken) : null
  const base = { sinceMs, holder: lease.convId.slice(0, 8), gen: lease.gen }

  // Released is a FACT, not an absence: the generation counter survives a
  // release, so an empty holder with a generation means it ran and let go.
  if (!lease.convId) return { ...base, kind: 'released' }

  // A holder whose conversation is gone is the 2026-08-18 failure verbatim: the
  // run keeps its grip, the next wake's CAS keeps losing, and nothing says so.
  const dead = !overseerAlive
  const ancient = sinceMs === null || sinceMs > LEASE_STALE_MS
  return { ...base, kind: dead || ancient ? 'stale' : 'held' }
}

// ---------------------------------------------------------------------------
// THE TAILS -- baton and beat pulse
// ---------------------------------------------------------------------------

/** How many baton entries the wall shows. The window shows all of them; a
 *  glanceable surface shows the last few and links out for the rest. */
const BATON_TAIL = 3

/** The baton arrives oldest-first (it is an append-only log); a tail reads
 *  newest-first, because the last thing that happened is the interesting one. */
export function batonTail(baton: readonly EpicLogEntry[], n: number = BATON_TAIL): EpicLogEntry[] {
  return baton.slice(-n).reverse()
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

// ---------------------------------------------------------------------------
// NIGHTSHIFT
// ---------------------------------------------------------------------------

const SETTLED = new Set<NightshiftTaskStatus>(['done', 'blocked', 'errored', 'skipped', 'integrated', 'discarded'])
const RUNNING = new Set<NightshiftTaskStatus>(['running', 'spinning'])

export interface NightshiftCounts {
  queued: number
  running: number
  settled: number
}

export function nightshiftCounts(tasks: readonly NightshiftTaskMeta[]): NightshiftCounts {
  const counts: NightshiftCounts = { queued: 0, running: 0, settled: 0 }
  for (const task of tasks) {
    if (task.status === 'queued') counts.queued++
    else if (RUNNING.has(task.status)) counts.running++
    else if (SETTLED.has(task.status)) counts.settled++
  }
  return counts
}
