/**
 * WHAT THE LAST FEW BEATS DID -- the debug half of the epic engine.
 *
 * A beat's outcome was `console.log` and nothing else, which made the first live
 * smoke's fourth finding possible at all: three epic lines reached `docker logs`
 * for a whole run, and `runEpicBeat`'s early return (`no run artifact`) logged
 * NOTHING, so the most common failure mode -- armed but nothing on disk --
 * looked exactly like a healthy idle sweep.
 *
 * So every beat also lands here, and `epic_run action=inspect` reads it back.
 * A ring, not a log file: this is a debugging aid, and an epic engine that could
 * exhaust memory by running for a long time would be a worse bug than the one it
 * exists to diagnose.
 *
 * DELIBERATELY IN MEMORY, same caveat as `epic-registry.ts`: a broker restart
 * forgets the beat history. The BATON is the durable record and always was --
 * this is the layer below it, the mechanical "what did the sweep actually do",
 * which has no business in a file the overseer reads as its own memory.
 */

import type { BeatOutcome } from './epic-executor'

/** Beats kept per epic. Two hours at the 45s tick -- long enough to explain a
 *  stall a human noticed and came to look at, short enough to stay cheap. */
const RING = 160

export interface BeatRecord extends BeatOutcome {
  /** Wall clock, so a stalled run's LAST beat is visibly old. */
  at: string
  /** Run generation the beat observed. */
  gen: number
  project: string
}

/** `${project} ${epicId}`, same key shape as the armed registry. */
type Key = string

const beats = new Map<Key, BeatRecord[]>()

function key(project: string, epicId: string): Key {
  return `${project} ${epicId}`
}

/** Record one beat. Oldest drops off the front once the ring is full. */
export function recordBeat(project: string, epicId: string, gen: number, outcome: BeatOutcome, nowMs: number): void {
  const k = key(project, epicId)
  const ring = beats.get(k) ?? []
  ring.push({ ...outcome, at: new Date(nowMs).toISOString(), gen, project })
  if (ring.length > RING) ring.splice(0, ring.length - RING)
  beats.set(k, ring)
}

/** The most recent beats, NEWEST LAST -- same order as the baton, so the two
 *  read the same way when an inspect prints them together. */
export function recentBeats(project: string, epicId: string, limit = 10): BeatRecord[] {
  const ring = beats.get(key(project, epicId)) ?? []
  return ring.slice(Math.max(0, ring.length - Math.max(1, limit)))
}

/** WHEN THIS EPIC LAST BEAT, or null if it never has. The ring keeps newest
 *  LAST, and getting that end wrong dates a stalled run to its first beat --
 *  which is why the slice lives here once rather than at each of the two feeds
 *  (`epic-active`'s badge row and `epic-inspect`'s `list`) that need it. */
export function lastBeatAt(project: string, epicId: string): string | null {
  const beats = recentBeats(project, epicId, 1)
  return beats.length > 0 ? (beats[beats.length - 1]?.at ?? null) : null
}

/**
 * Deliberately NO `forget` twin to `forgetArmedEpic`. A run that just parked or
 * completed is precisely the one somebody comes to inspect, and dropping its
 * beats the instant it went terminal would delete the post-mortem at the moment
 * it became interesting. The per-epic ring is capped, so what grows is one small
 * array per epic ever run -- bounded by how many epics a human starts.
 */

/** Tests only. */
export function resetBeatLog(): void {
  beats.clear()
}
