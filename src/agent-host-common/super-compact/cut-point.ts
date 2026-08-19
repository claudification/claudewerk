/**
 * Point-in-time cut: choose WHICH slice of a transcript a fold operates on.
 *
 * A fork from HEAD carries everything. A fork from a POINT carries one side of a
 * boundary entry -- the history up to a message you want to re-do differently
 * (`before`), or the recent tail of a bloated session you want to keep working in
 * (`after`).
 *
 * ## Why the boundary is (uuid, timestamp) and not a uuid
 *
 * The control panel's transcript is NOT a 1:1 view of CC's JSONL. Measured over
 * six real conversations (2458 entries): assistant entries carry the real CC uuid
 * 100% of the time, user entries ~91%, and rclaude's own chrome (boot, launch,
 * queue-operation) 0% -- those rows exist only in the panel. The user misses are
 * voice-dictated and `<system-reminder>`-wrapped prompts plus coalesced-queue
 * splits, where the live stdin echo's text differs from CC's file row so
 * `syntheticUserUuid`'s content hash never collapses the two.
 *
 * Resolving uuid-first and falling back to "last file row at or before this
 * timestamp" makes every visible entry a legal cut point. The worst case is a
 * boundary one message off, never a dead button.
 */

import type { Entry } from './model'

/** Which side of the boundary the fork carries. */
export type CutDirection = 'before' | 'after'

export interface CutPoint {
  /** CC uuid of the boundary entry. Tried first; may not exist in the file. */
  uuid?: string
  /** ISO-8601 fallback used when `uuid` does not resolve. */
  timestamp?: string
  /** `before` keeps history up TO the boundary; `after` keeps the boundary ONWARD. */
  direction: CutDirection
  /** Whether the boundary entry itself survives. */
  inclusive: boolean
}

/** How the boundary was located. `none` means no cut was applied. */
export type CutResolution = 'uuid' | 'timestamp' | 'none'

export interface CutResult {
  /** The slice the fold will operate on. Never empty. */
  kept: Entry[]
  /** The discarded slice, in original order. Empty when nothing was cut. */
  dropped: Entry[]
  resolvedBy: CutResolution
  /** Index of the boundary in the input, or -1 when unresolved. */
  boundaryIndex: number
}

function entryTimeMs(e: Entry): number | undefined {
  const ts = e.raw.timestamp
  if (typeof ts === 'number') return ts
  if (typeof ts !== 'string') return undefined
  const ms = Date.parse(ts)
  return Number.isNaN(ms) ? undefined : ms
}

function findByUuid(entries: Entry[], uuid: string): number {
  return entries.findIndex(e => e.id === uuid || e.raw.uuid === uuid)
}

/**
 * Last entry at or before `ms`. Entries are in chain order but timestamps are not
 * guaranteed monotonic (CC interleaves sidechains), so this scans rather than
 * bisects -- a transcript is thousands of rows, not millions.
 */
function findByTime(entries: Entry[], ms: number): number {
  let best = -1
  for (let i = 0; i < entries.length; i++) {
    const t = entryTimeMs(entries[i])
    if (t !== undefined && t <= ms) best = i
  }
  return best
}

function resolveBoundary(entries: Entry[], cut: CutPoint): { index: number; by: CutResolution } {
  if (cut.uuid) {
    const i = findByUuid(entries, cut.uuid)
    if (i >= 0) return { index: i, by: 'uuid' }
  }
  if (cut.timestamp) {
    const ms = Date.parse(cut.timestamp)
    if (!Number.isNaN(ms)) {
      const i = findByTime(entries, ms)
      if (i >= 0) return { index: i, by: 'timestamp' }
    }
  }
  return { index: -1, by: 'none' }
}

const UNCUT = (entries: Entry[]): CutResult => ({
  kept: entries,
  dropped: [],
  resolvedBy: 'none',
  boundaryIndex: -1,
})

/**
 * Slice `entries` at `cut`. Pure; the input array is never mutated.
 *
 * An unresolvable boundary and a cut that would keep NOTHING both degrade to the
 * full transcript rather than throwing. A fork is a context transfer -- handing
 * back everything is a worse fork, handing back an empty session is not a session
 * at all, and `resolvedBy: 'none'` tells the caller which happened.
 */
export function applyCut(entries: Entry[], cut: CutPoint): CutResult {
  const { index, by } = resolveBoundary(entries, cut)
  if (index < 0) return UNCUT(entries)

  const splitAt = cut.direction === 'before' ? (cut.inclusive ? index + 1 : index) : cut.inclusive ? index : index + 1

  const head = entries.slice(0, splitAt)
  const tail = entries.slice(splitAt)
  const kept = cut.direction === 'before' ? head : tail
  const dropped = cut.direction === 'before' ? tail : head

  if (kept.length === 0) return UNCUT(entries)
  return { kept, dropped, resolvedBy: by, boundaryIndex: index }
}
