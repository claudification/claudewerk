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
 * This module holds the two ORDERINGS -- a from-scratch sort and an incremental
 * splice. They must agree entry-for-entry, so both take their sort key from
 * `transcript-order-keys.ts`, which is also where the undated-entry and
 * clock-jitter rules are documented.
 */

import type { TranscriptEntry } from './protocol'
import { CLOCK_JITTER_MS, carriedTailKey, entryTime, orderKeys, sortsBefore } from './transcript-order-keys'

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
 * recovered from the file -- pays for the binary search. An undated INCOMING
 * entry is always pushed: we have nothing to place it by, and its arrival
 * position is the best answer available. An undated entry already IN the list is
 * a different matter -- see `carriedTailKey`, whose absence turned this whole
 * function into a blind append.
 */
export function insertTranscriptEntriesInOrder(list: TranscriptEntry[], incoming: TranscriptEntry[]): void {
  for (const entry of incoming) {
    const key = entryTime(entry)
    const seq = entry.seq ?? 0
    const last = list[list.length - 1]
    const lastKey = carriedTailKey(list)
    if (key === null || !last || !sortsBefore(key, seq, lastKey, last.seq ?? 0)) {
      list.push(entry)
      continue
    }
    // Reads behind the tail, but only by jitter and directly continuing it:
    // it arrived in order (same rule as orderKeys) and belongs at the tail.
    if (continuesTailInOrder(list, key, seq, lastKey)) {
      list.push(entry)
      continue
    }
    list.splice(upperBound(list, key, seq), 0, entry)
  }
}

/**
 * An entry that DIRECTLY CONTINUES the list but reads slightly behind its
 * predecessor's clock -- CC's non-monotonic stamping, not a displaced arrival.
 *
 * The comparison is against the entry this one FOLLOWS BY SEQ, which must also
 * be the tail. Comparing against the tail alone is not enough: a refetch batch
 * splices older gap-fills in first, leaving a much newer live entry at the tail,
 * and a genuine gap-fill that happens to land within a minute of THAT would be
 * wrongly appended (it belongs next to its own seq neighbours). If the tail does
 * not hold the highest seq in the list, this entry is not continuing anything.
 */
function continuesTailInOrder(list: TranscriptEntry[], key: number, seq: number, lastKey: number): boolean {
  const last = list[list.length - 1]
  const lastSeq = last?.seq
  if (typeof lastSeq !== 'number' || seq <= lastSeq) return false
  for (const e of list) {
    if (typeof e.seq === 'number' && e.seq > lastSeq) return false
  }
  return lastKey - key <= CLOCK_JITTER_MS
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
