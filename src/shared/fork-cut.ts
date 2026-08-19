/**
 * The point-in-time cut, as pure math over any ordered list.
 *
 * TWO components slice a transcript at the same boundary and must agree exactly:
 * the SENTINEL cuts CC's JSONL (super-compact `Entry[]`) to build the fold, and
 * the BROKER cuts its own SQLite copy (`TranscriptEntry[]`) to summarize whatever
 * the fold is about to discard. Same boundary, two shapes, one rule -- so the rule
 * lives here and each side supplies accessors.
 *
 * ## Why a boundary is (uuid, timestamp) and not a uuid
 *
 * The control panel's transcript is not a 1:1 view of CC's JSONL. Measured over
 * six real conversations (2458 entries): assistant rows carry the real CC uuid
 * 100% of the time, user rows ~91%, and rclaude's own chrome -- boot, launch,
 * queue-operation -- 0%, because those rows exist only in the panel. The user
 * misses are voice-dictated and `<system-reminder>`-wrapped prompts plus
 * coalesced-queue splits, where the live stdin echo's text differs from CC's file
 * row so `syntheticUserUuid`'s content hash never collapses the two.
 *
 * Resolving uuid-first and falling back to "last row at or before this timestamp"
 * makes every entry the user can see a legal cut point. Worst case the boundary
 * lands one message off; it is never a dead button.
 */

/** Which side of the boundary the fork carries. */
export type CutDirection = 'before' | 'after'

export interface CutBoundary {
  /** Stable id of the boundary row. Tried first; may not exist in the target list. */
  uuid?: string
  /** ISO-8601 fallback used when `uuid` does not resolve. */
  timestamp?: string
  /** `before` keeps history up TO the boundary; `after` keeps the boundary ONWARD. */
  direction: CutDirection
  /** Whether the boundary row itself survives. */
  inclusive: boolean
}

/** How the boundary was located. `none` means no cut was applied. */
export type CutResolution = 'uuid' | 'timestamp' | 'none'

export interface CutAccessors<T> {
  uuidOf(item: T): string | undefined
  /** Epoch ms, or undefined when the row carries no usable timestamp. */
  timeOf(item: T): number | undefined
}

export interface SliceResult<T> {
  /** The slice the caller keeps. Never empty unless the input was. */
  kept: T[]
  /** The discarded slice, in original order. Empty when nothing was cut. */
  dropped: T[]
  resolvedBy: CutResolution
  /** Index of the boundary in the input, or -1 when unresolved. */
  boundaryIndex: number
}

/** Parse an ISO string or epoch-ms number into epoch ms. */
export function toEpochMs(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined
  if (typeof value !== 'string') return undefined
  const ms = Date.parse(value)
  return Number.isNaN(ms) ? undefined : ms
}

/**
 * Last row at or before `ms`. Rows are in chain order but their timestamps are
 * not guaranteed monotonic (CC interleaves sidechains), so this scans rather than
 * bisects -- a transcript is thousands of rows, not millions.
 */
function findByTime<T>(items: T[], ms: number, acc: CutAccessors<T>): number {
  let best = -1
  for (let i = 0; i < items.length; i++) {
    const t = acc.timeOf(items[i])
    if (t !== undefined && t <= ms) best = i
  }
  return best
}

function resolveBoundary<T>(items: T[], cut: CutBoundary, acc: CutAccessors<T>): { index: number; by: CutResolution } {
  if (cut.uuid) {
    const i = items.findIndex(x => acc.uuidOf(x) === cut.uuid)
    if (i >= 0) return { index: i, by: 'uuid' }
  }
  const ms = toEpochMs(cut.timestamp)
  if (ms !== undefined) {
    const i = findByTime(items, ms, acc)
    if (i >= 0) return { index: i, by: 'timestamp' }
  }
  return { index: -1, by: 'none' }
}

const uncut = <T>(items: T[]): SliceResult<T> => ({
  kept: items,
  dropped: [],
  resolvedBy: 'none',
  boundaryIndex: -1,
})

/**
 * Slice `items` at `cut`. Pure; the input array is never mutated.
 *
 * An unresolvable boundary and a cut that would keep NOTHING both degrade to the
 * full list rather than throwing. A fork is a context transfer -- carrying
 * everything is a worse fork, carrying nothing is not a session at all, and
 * `resolvedBy: 'none'` tells the caller which of the two happened.
 */
export function sliceAtCut<T>(items: T[], cut: CutBoundary, acc: CutAccessors<T>): SliceResult<T> {
  const { index, by } = resolveBoundary(items, cut, acc)
  if (index < 0) return uncut(items)

  const splitAt = cut.direction === 'before' ? (cut.inclusive ? index + 1 : index) : cut.inclusive ? index : index + 1

  const head = items.slice(0, splitAt)
  const tail = items.slice(splitAt)
  const kept = cut.direction === 'before' ? head : tail
  const dropped = cut.direction === 'before' ? tail : head

  if (kept.length === 0) return uncut(items)
  return { kept, dropped, resolvedBy: by, boundaryIndex: index }
}
