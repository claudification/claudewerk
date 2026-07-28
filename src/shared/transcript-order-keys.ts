/**
 * The SORT KEY behind chronological transcript order -- read `transcript-order.ts`
 * first for why chronology and arrival are not the same thing.
 *
 * Everything here answers one question: what number does an entry sort on? Both
 * orderings in `transcript-order.ts` -- the from-scratch sort and the
 * incremental splice -- have to answer it identically, so it lives in one place
 * rather than being re-derived at each call site (a disagreement between the two
 * is what makes entries move around on screen when a conversation reloads).
 *
 * Two rules make the key non-obvious:
 *
 * ## Undated entries inherit, they never guess
 *
 * `agent-name`, `custom-title` and friends carry no timestamp at all. Dating one
 * `Date.now()` is fine for a write (it happens once) and corrupting for a sort:
 * the key changes between comparisons, the comparator stops being a total order,
 * and the result is garbage. An undated entry instead inherits the key of the
 * nearest preceding dated entry, so it keeps the position it arrived in.
 *
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
 * later, and is placed chronologically. The invariant is "entries CC emitted in
 * a definite order are never reordered against each other", with the clock used
 * only to repair genuinely displaced arrivals.
 *
 * The clamp needs arrival information, which is what `seq` is. Entries with NO
 * seq carry no arrival evidence, so they are never clamped -- they sort on their
 * raw clock exactly as before.
 */

import type { TranscriptEntry } from './protocol'

export const CLOCK_JITTER_MS = 60_000

/** Milliseconds for an entry's own clock, or `null` when it carries no usable one. */
export function entryTime(entry: TranscriptEntry): number | null {
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
export function orderKeys(entries: TranscriptEntry[]): number[] {
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

/**
 * The sort key the LAST entry of a list carries -- its own clock, or the nearest
 * preceding dated entry's when it is undated. `-Infinity` for an all-undated
 * list, which has no clock to place anything by.
 *
 * The incremental splice compares arrivals against this rather than against the
 * tail's RAW clock. Reading the raw clock returned -Infinity the moment an
 * undated entry landed last -- nothing sorts before that, so every subsequent
 * arrival was blind-pushed to the end no matter what its own clock said. In conv
 * `daf1f369` (2026-07-28) a prompt recovered from the JSONL 432s late arrived
 * one second behind an `agent-name` and rendered BELOW entries stamped seven
 * minutes after it, in the broker cache, where a reload could not repair it.
 *
 * A single comparison whenever the tail is dated, which is the normal case.
 */
export function carriedTailKey(list: TranscriptEntry[]): number {
  for (let i = list.length - 1; i >= 0; i--) {
    const t = entryTime(list[i])
    if (t !== null) return t
  }
  return Number.NEGATIVE_INFINITY
}

/** Does `(keyA, seqA)` sort strictly before `(keyB, seqB)`? The predicate form
 *  of the same `(timestamp, seq)` order the batch comparator uses. */
export function sortsBefore(keyA: number, seqA: number, keyB: number, seqB: number): boolean {
  return keyA !== keyB ? keyA < keyB : seqA < seqB
}
