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
import type { Reader, Writer } from './io'
import type { TranscriptAdapter } from './model'

export type { CompactOptions, CompactResult } from './compactor'
export * from './io'
export * from './model'
export * from './tokens'

export async function runCompaction(
  reader: Reader,
  writer: Writer,
  adapter: TranscriptAdapter,
  opts: CompactOptions,
): Promise<CompactResult> {
  const raw = await reader.read()
  const transcript = adapter.parse(raw)
  const result = superCompact(transcript, opts)
  await writer.write(adapter.serialize(result.transcript))
  return result
}
