/**
 * Per-message-type wire accounting -- the DATA half of the perf monitor.
 *
 * The existing instrumentation measures CPU: `ws`/`message` samples time the
 * parse and the handler apply, `render` times the commit. None of it answers
 * "what did we DOWNLOAD, and what was in it" -- and on a cold panel boot that is
 * the dominant cost. `ws-stats` counts aggregate bytes/sec with no attribution,
 * so a fat boot snapshot reads as an anonymous throughput spike.
 *
 * This module keys bytes on message TYPE, and for the fat types runs
 * `analysePayload` ONCE to name the heaviest fields inside. Zero overhead while
 * the perf monitor is off: `recordWireIn` returns on its first line.
 */

import { analysePayload, type FieldWeight } from './payload-anatomy'
import { isPerfEnabled, onPerfReset } from './perf-metrics'

export interface WireTypeStat {
  type: string
  /** Messages of this type seen since the monitor was enabled. */
  n: number
  /** Total decoded bytes (JSON text length, pre-`JSON.parse`). */
  bytes: number
  /** Largest single instance. */
  maxBytes: number
  /** Total `onmessage` cost (parse + routing) attributed to this type. */
  cpuMs: number
  /** ms since the monitor was enabled, for the first and last instance. */
  firstAtMs: number
  lastAtMs: number
  /** Field breakdown of the largest instance seen, once it crossed the
   *  threshold. Undefined for types that never got fat enough to be worth it. */
  fields?: FieldWeight[]
}

/**
 * Only messages at or above this size get a field breakdown. Below it the
 * analysis costs more than the bytes it would explain, and the interesting
 * payloads (bulk lists, transcript pages, snapshots) are all far above it.
 */
export const ANATOMY_THRESHOLD_BYTES = 32 * 1024

const stats = new Map<string, WireTypeStat>()
let epoch = 0
const listeners = new Set<() => void>()

function notify() {
  snapshotStale = true
  for (const fn of listeners) fn()
}

/**
 * Record one inbound wire message.
 *
 * Call AFTER parsing, from the single `onmessage` seam, with the already-parsed
 * payload so the anatomy pass never re-parses. `cpuMs` is the same span the `ws`
 * perf sample records, so the two views agree by construction.
 */
export function recordWireIn(type: string, bytes: number, cpuMs: number, payload?: unknown): void {
  if (!isPerfEnabled()) return
  if (epoch === 0) epoch = performance.now()
  const at = performance.now() - epoch
  const prev = stats.get(type)
  const stat: WireTypeStat = prev ?? {
    type,
    n: 0,
    bytes: 0,
    maxBytes: 0,
    cpuMs: 0,
    firstAtMs: at,
    lastAtMs: at,
  }
  stat.n += 1
  stat.bytes += bytes
  stat.cpuMs += cpuMs
  stat.lastAtMs = at
  // Analyse only when this instance is BOTH over the threshold and the fattest
  // one yet -- so a type is dissected at most once per new high-water mark, and
  // the breakdown always describes the worst case the user actually paid for.
  const isNewMax = bytes > stat.maxBytes
  if (isNewMax) stat.maxBytes = bytes
  if (isNewMax && bytes >= ANATOMY_THRESHOLD_BYTES && payload !== undefined) {
    stat.fields = analysePayload(payload)
  }
  stats.set(type, stat)
  notify()
}

/**
 * Cached snapshot. `useSyncExternalStore` compares snapshots by REFERENCE and
 * re-renders forever if the getter mints a fresh array each call (React #185) --
 * so the sorted array is built once per mutation and handed out until the next.
 */
let snapshot: WireTypeStat[] = []
let snapshotStale = true

export function getWireStats(): WireTypeStat[] {
  if (snapshotStale) {
    // Copy each stat: the entries are mutated in place on every subsequent
    // message, so handing out the live objects would let a memoized consumer
    // read new numbers behind an unchanged reference.
    snapshot = [...stats.values()].map(s => ({ ...s })).sort((a, b) => b.bytes - a.bytes)
    snapshotStale = false
  }
  return snapshot
}

export function totalWireBytes(): number {
  let total = 0
  for (const s of stats.values()) total += s.bytes
  return total
}

export function clearWireStats(): void {
  stats.clear()
  epoch = 0
  notify()
}

export function subscribeWireStats(fn: () => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// Turning the monitor off (or clearing the ring buffer) resets this too, so a
// capture always covers exactly the window the user reproduced in.
onPerfReset(clearWireStats)
