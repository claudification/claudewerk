/**
 * Point-in-time cut for a super-compact transcript.
 *
 * The rule itself lives in `src/shared/fork-cut.ts` because the BROKER applies
 * the identical boundary to its own SQLite copy of the transcript. This file is
 * just the accessors for the super-compact `Entry` shape.
 */

import { type CutAccessors, type CutBoundary, type SliceResult, sliceAtCut, toEpochMs } from '../../shared/fork-cut'
import type { Entry } from './model'

export type { CutResolution } from '../../shared/fork-cut'

/** A boundary expressed against super-compact entries. */
export type CutPoint = CutBoundary

export type CutResult = SliceResult<Entry>

const ENTRY_ACCESSORS: CutAccessors<Entry> = {
  // `id` is the parsed uuid; `raw.uuid` is the same value straight off the JSONL
  // row. Checking both keeps this working for entries an adapter left unparsed.
  uuidOf: e => e.id ?? (typeof e.raw.uuid === 'string' ? e.raw.uuid : undefined),
  timeOf: e => toEpochMs(e.raw.timestamp),
}

export function applyCut(entries: Entry[], cut: CutPoint): CutResult {
  return sliceAtCut(entries, cut, ENTRY_ACCESSORS)
}
