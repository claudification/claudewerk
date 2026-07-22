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

/**
 * ## The clock is not monotonic -- clamp small inversions away
 *
 * CC's own timestamps go BACKWARDS between entries it emitted in a definite
 * order. The injected body of a skill is stamped 150-800ms BEFORE the Skill
 * tool_result that names it -- 15 of 15 invocations in the production store.
 * Sorting on the raw clock swapped that pair, the grouper never saw
 * `toolUseResult.commandName` ahead of the body, and every skill rendered as a
 * fat user bubble instead of a `/chip` (2026-07-23).
 *
 * The two populations are three orders of magnitude apart. Measured over one
 * day of seq-adjacent pairs:
 *
 *   in order                                        42893
 *   inverted <1s     (clock jitter, arrived in order)  507
 *   inverted 1s-60s                                    425
 *   inverted 1m-1h   (genuine late gap-fill)          2626
 *   inverted >1h     (genuine late gap-fill)          1172
 *
 * So: an entry that reads behind the running clock by no more than
 * CLOCK_JITTER_MS arrived IN ORDER and keeps its arrival position; anything
 * further behind is a real gap-fill recovered from the JSONL minutes or hours
 * later, and is placed chronologically. The invariant is
 * "entries CC emitted in a definite order are never reordered against each
 * other", with the clock used only to repair genuinely displaced arrivals.
 *
 * The clamp needs arrival information, which is what `seq` is. Entries with NO
 * seq carry no arrival evidence, so they are never clamped -- they sort on
 * their raw clock exactly as before.
 */
const CLOCK_JITTER_MS = 60_000

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
 *  to their arrival position under a stable sort.
 *
 *  Dated entries that also carry a `seq` are then walked in ARRIVAL order and
 *  clamped forward past sub-CLOCK_JITTER_MS clock inversions (see above), so a
 *  backwards-stamped neighbour cannot overtake the entry it followed. */
function orderKeys(entries: TranscriptEntry[]): number[] {
  const keys = new Array<number>(entries.length)
  let carried = Number.NEGATIVE_INFINITY
  for (let i = 0; i < entries.length; i++) {
    const t = entryTime(entries[i])
    if (t !== null) carried = t
    keys[i] = carried
  }
  clampJitterInArrivalOrder(entries, keys)
  return keys
}

/** Walk the seq-bearing entries in arrival order, dragging each key forward to
 *  the running maximum whenever it reads behind by less than the jitter bound.
 *  Mutates `keys` in place. */
function clampJitterInArrivalOrder(entries: TranscriptEntry[], keys: number[]): void {
  const arrival: number[] = []
  for (let i = 0; i < entries.length; i++) {
    if (typeof entries[i].seq === 'number' && entryTime(entries[i]) !== null) arrival.push(i)
  }
  arrival.sort((a, b) => (entries[a].seq as number) - (entries[b].seq as number) || a - b)

  let runningMax = Number.NEGATIVE_INFINITY
  for (const i of arrival) {
    const key = keys[i]
    // Behind the running clock, but not far enough behind to be a real
    // gap-fill: this entry arrived in order, so pin it there.
    if (key < runningMax && runningMax - key <= CLOCK_JITTER_MS) keys[i] = runningMax
    else if (key > runningMax) runningMax = key
  }
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
    const lastKey = last ? (entryTime(last) ?? Number.NEGATIVE_INFINITY) : Number.NEGATIVE_INFINITY
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
