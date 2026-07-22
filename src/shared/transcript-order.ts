/**
 * CHRONOLOGY, not arrival.
 *
 * `seq` is an ARRIVAL counter -- the store hands out `MAX(seq)+1` per scope, in
 * the order batches reach the broker. It is the right key for dedup, delta
 * (`?since=`) and sync bookkeeping, and it is the WRONG key for render order,
 * because the two orders are not the same:
 *
 * A headless conversation feeds the broker from two disjoint sources. Anything
 * the stdout pipe never carries -- `system/stop_hook_summary`, `api_error`, and
 * any entry stdout dropped during a socket blip -- reaches the broker only via
 * a file resend, MINUTES after it happened. Measured on the production store:
 * 82 of 82 `stop_hook_summary` rows in one day arrived late, average 28 minutes,
 * worst 2.5 hours. Each got `MAX(seq)+1` while keeping its ORIGINAL timestamp,
 * so ordering by seq pinned a 20:23 entry BELOW a 20:42 one -- permanently.
 *
 * Render order is therefore `(timestamp, seq)`: the entry's own clock first,
 * with seq breaking ties so entries stamped in the same millisecond keep the
 * order they were produced in.
 *
 * ## Undated entries never move
 *
 * Ordering deliberately does NOT reuse `resolveEntryTimestamp` from the persist
 * path. That helper dates an undated entry `Date.now()`, which is fine for a
 * write (it happens once) and corrupting for a sort (the key changes between
 * comparisons, so the comparator stops being a total order and the result is
 * garbage). Here an entry we cannot date inherits the key of the nearest
 * preceding dated entry instead, so it keeps the position it arrived in.
 */

import type { TranscriptEntry } from './protocol'

/** Milliseconds for an entry's own clock, or `null` when it carries no usable one. */
function entryTime(entry: TranscriptEntry): number | null {
  const raw = entry.timestamp
  if (typeof raw === 'number') return Number.isFinite(raw) ? raw : null
  if (typeof raw !== 'string') return null
  const parsed = Date.parse(raw)
  return Number.isNaN(parsed) ? null : parsed
}

/** Resolve one sort key per entry, ONCE. Undated entries carry forward the key
 *  of the entry before them (and lead with -Infinity), which keeps them pinned
 *  to their arrival position under a stable sort. */
function orderKeys(entries: TranscriptEntry[]): number[] {
  const keys = new Array<number>(entries.length)
  let carried = Number.NEGATIVE_INFINITY
  for (let i = 0; i < entries.length; i++) {
    const t = entryTime(entries[i])
    if (t !== null) carried = t
    keys[i] = carried
  }
  return keys
}

/** Sort a batch chronologically. Stable, so equal keys keep arrival order. */
export function sortTranscriptEntries(entries: TranscriptEntry[]): TranscriptEntry[] {
  const keys = orderKeys(entries)
  return entries
    .map((entry, i) => ({ entry, key: keys[i], i }))
    .sort((a, b) => a.key - b.key || (a.entry.seq ?? 0) - (b.entry.seq ?? 0) || a.i - b.i)
    .map(x => x.entry)
}

/**
 * Splice `incoming` into an already-ordered `list`, in place, keeping it ordered.
 *
 * The overwhelmingly common case is a live entry that belongs at the end, so
 * that is one comparison and a push. Only an out-of-order arrival -- a gap-fill
 * recovered from the file -- pays for the binary search. An undated entry is
 * always pushed: we have nothing to place it by, and its arrival position is
 * the best answer available.
 */
export function insertTranscriptEntriesInOrder(list: TranscriptEntry[], incoming: TranscriptEntry[]): void {
  for (const entry of incoming) {
    const key = entryTime(entry)
    const seq = entry.seq ?? 0
    const last = list[list.length - 1]
    if (key === null || !last || !sortsBefore(key, seq, entryTime(last) ?? Number.NEGATIVE_INFINITY, last.seq ?? 0)) {
      list.push(entry)
      continue
    }
    list.splice(upperBound(list, key, seq), 0, entry)
  }
}

/** Does `(keyA, seqA)` sort strictly before `(keyB, seqB)`? The predicate form
 *  of the same `(timestamp, seq)` order `sortTranscriptEntries` comparator uses. */
function sortsBefore(keyA: number, seqA: number, keyB: number, seqB: number): boolean {
  return keyA !== keyB ? keyA < keyB : seqA < seqB
}

/** First index sorting AFTER `(key, seq)` -- the stable insertion point.
 *  Undated list members inherit the preceding key, matching `orderKeys`. */
function upperBound(list: TranscriptEntry[], key: number, seq: number): number {
  // The carry-forward is a scan, not a bisection, so resolve the whole list's
  // keys up front -- one pass, and only on the rare out-of-order path.
  const keys = orderKeys(list)
  let lo = 0
  let hi = list.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sortsBefore(key, seq, keys[mid], list[mid].seq ?? 0)) hi = mid
    else lo = mid + 1
  }
  return lo
}
