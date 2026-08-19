/**
 * Super-compact: deterministic, reversible transcript compaction.
 *
 * Layering (each independently swappable / testable):
 *   Reader/Writer  -- bytes      (string for tests, file for the agent host)
 *   TranscriptAdapter -- format   (Claude Code JSONL <-> normalized model)
 *   superCompact   -- logic       (agnostic; the fold theories live here)
 *
 * `runCompaction` is the one-call pipeline that ties them together. Wiring this
 * into the agent host is just: FileReader + FileWriter + ClaudeCodeAdapter + a
 * trigger -- no logic changes from the test path.
 */

import { type CompactOptions, type CompactResult, superCompact } from './compactor'
import { applyCut, type CutPoint, type CutResolution } from './cut-point'
import type { Reader, Writer } from './io'
import type { Entry, TranscriptAdapter } from './model'

export type { CompactOptions, CompactResult } from './compactor'
export * from './cut-point'
export * from './io'
export * from './model'
export * from './tokens'

export interface RunCompactionOptions extends CompactOptions {
  /**
   * Fold only one side of a boundary entry. Omitted = fold the whole transcript,
   * which is what a fork from HEAD does.
   *
   * The cut runs in the PIPELINE rather than inside `superCompact` so the fold
   * logic stays a pure Transcript -> Transcript function that knows nothing about
   * where a caller decided to slice.
   */
  cutAt?: CutPoint
}

export interface RunCompactionHooks {
  /**
   * Called with the discarded slice after a cut, before the fold. Whatever text
   * it returns is appended to the provenance block, i.e. the very top of the
   * synthesized preamble.
   *
   * This is the seam for summarizing the part you are throwing away -- keeping the
   * recent turns verbatim while one paragraph stands in for the ancient history.
   * The hook is supplied by the caller precisely so this layer never learns what a
   * model is.
   */
  onDropped?: (dropped: Entry[]) => Promise<string | undefined>
}

export interface RunCompactionResult extends CompactResult {
  cut: { resolvedBy: CutResolution; keptEntries: number; droppedEntries: number }
}

const NO_CUT = { resolvedBy: 'none' as CutResolution, droppedEntries: 0 }

function joinProvenance(...parts: Array<string | undefined>): string | undefined {
  const kept = parts.filter((p): p is string => typeof p === 'string' && p.length > 0)
  return kept.length ? kept.join('\n\n') : undefined
}

export async function runCompaction(
  reader: Reader,
  writer: Writer,
  adapter: TranscriptAdapter,
  opts: RunCompactionOptions,
  hooks?: RunCompactionHooks,
): Promise<RunCompactionResult> {
  const raw = await reader.read()
  const parsed = adapter.parse(raw)

  const { cutAt, ...foldOpts } = opts
  const cut = cutAt ? applyCut(parsed.entries, cutAt) : null
  const transcript = cut ? { ...parsed, entries: cut.kept } : parsed

  const droppedSummary = cut?.dropped.length ? await hooks?.onDropped?.(cut.dropped) : undefined
  const provenanceBlock = joinProvenance(foldOpts.provenanceBlock, droppedSummary)

  const result = superCompact(transcript, { ...foldOpts, provenanceBlock })
  await writer.write(adapter.serialize(result.transcript))

  const { resolvedBy, droppedEntries } = cut
    ? { resolvedBy: cut.resolvedBy, droppedEntries: cut.dropped.length }
    : NO_CUT
  return { ...result, cut: { resolvedBy, droppedEntries, keptEntries: transcript.entries.length } }
}
