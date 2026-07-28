/**
 * The MAP stage's per-chunk pipeline: one chunk in, one extraction out, and an
 * honest verdict about what it cost to get there.
 *
 * The escalation, cheapest first:
 *
 *   1. call + strict parse         -> `parsed`   (trusted; cacheable)
 *   2. salvage, nothing lost       -> `salvaged` (free; no re-ask needed)
 *   3. repair re-ask + strict parse-> `parsed`   (~$0.025; trusted)
 *   4. fall back to the salvage    -> `salvaged` (incomplete, but most of it)
 *   5. nothing recoverable         -> `failed`   (empty metadata; named casualty)
 *
 * Step 3 is the fix for the 2026-07-28 incident, and it is not a new idea here:
 * the SYNTHESIS stage has re-asked on a malformed response since day one
 * (`parseOrRetry`). The map stage simply never got the same treatment, so a
 * single malformed array was terminal for a whole conversation. A map re-ask
 * costs about 2.5 cents against a map stage that routinely costs $5.
 *
 * `salvaged` is deliberately NOT `parsed`: the extraction is incomplete, so it
 * must never be filed in the cross-run map cache (that would pin the
 * conversation to a partial fact set for the life of the entry) and must never
 * be banked as a reusable bundle chunk (a resume should re-run it clean).
 */

import type { RecapChunkFailure, RecapMetadata } from '../../../../shared/protocol'
import type { ChatRequest } from '../../shared/openrouter-client'
import { lostChunk, salvagedChunk } from './map-failure'
import { buildMapPrompt, MapParseError, parseMapOutput } from './map-prompt'
import { makeEmptyMetadata } from './merge'
import { describeSalvage, salvageMapOutput } from './salvage'
import type { TranscriptChunk } from './split'

/** What became of one chunk. Only 'parsed' is trusted for caching/banking. */
export type MapChunkOutcome = 'parsed' | 'salvaged' | 'failed'

export interface MapChunkResult {
  metadata: RecapMetadata
  outcome: MapChunkOutcome
  /** Present for 'salvaged' and 'failed' -- the record to persist + surface. */
  failure?: RecapChunkFailure
}

/** Everything the pipeline needs from the orchestrator, as functions, so this
 *  module stays free of orchestrator/deps internals (and trivially testable). */
export interface MapChunkRunner {
  /** Issue one LLM call, already wired to the ledger + bundle + stage deadline. */
  call: (stage: 'map' | 'map-repair', req: ChatRequest, chunkIndex: number) => Promise<string>
  /** Base request fields (model, timeouts, temperature, signal, apiKey...). */
  request: Omit<ChatRequest, 'system' | 'user' | 'messages'>
  /** Progress line sink. */
  emit: (level: 'info' | 'warn', message: string) => void
  /** Set false to spend nothing on repair (salvage-only). Default true. */
  repair?: boolean
}

/** A map extraction that came back this large almost certainly hit the output
 *  token cap (finish_reason=length) and is truncated mid-JSON -- a normal map
 *  output is well under 20k chars. Used only to LABEL the failure actionably (a
 *  truncated chunk wants a smaller CLAUDWERK_RECAP_CHUNK_SIZE_CHARS, not a
 *  re-ask); the authoritative finish_reason is in the bundle's raw response. */
const TRUNCATION_HINT_CHARS = 50_000

const REPAIR_INSTRUCTION =
  'Your previous response was not valid JSON and could not be parsed. Re-emit the SAME extraction as ' +
  'ONE valid JSON object matching the specified schema exactly. Every array element must match its ' +
  'declared type: the Item[] keys (features, bugs, fixes, incidents, decisions, dead_ends, gotchas, ' +
  'frustrations) take OBJECTS with a "title" -- never bare strings, and never a loose "conversations" ' +
  'key inside the array. Output the JSON object and nothing else.'

/** Run one chunk through the escalation. Never throws for a parse problem; a
 *  transport error (timeout, cancellation, stage deadline) still propagates so
 *  the caller can tell "the model was wrong" apart from "the call never landed". */
export async function runMapChunk(runner: MapChunkRunner, chunk: TranscriptChunk): Promise<MapChunkResult> {
  const prompt = buildMapPrompt(chunk)
  const content = await runner.call('map', { ...runner.request, system: prompt.system, user: prompt.user }, chunk.index)
  try {
    return { metadata: parseMapOutput(content), outcome: 'parsed' }
  } catch (err) {
    if (!(err instanceof MapParseError)) throw err
    return await recover(runner, chunk, prompt, content, err)
  }
}

async function recover(
  runner: MapChunkRunner,
  chunk: TranscriptChunk,
  prompt: { system: string; user: string },
  content: string,
  parseError: MapParseError,
): Promise<MapChunkResult> {
  const salvaged = salvageMapOutput(content)
  const detail = describeSalvage(salvaged)
  const label = `chunk ${chunk.index + 1}`
  // Truncation is a SIZING problem, not a shape problem: re-asking the same
  // oversized chunk buys another response that overflows the same cap. Never
  // re-ask, keep whatever landed, and name the knob that actually fixes it.
  if (content.length > TRUNCATION_HINT_CHARS) {
    runner.emit(
      'warn',
      `${label} map output truncated at the token cap (${content.length} chars) -- ${detail}; ` +
        'chunk too large, reduce CLAUDWERK_RECAP_CHUNK_SIZE_CHARS',
    )
    const note = `truncated at the token cap (${content.length} chars) -- ${detail}`
    if (salvaged.recovered > 0) {
      return {
        metadata: salvaged.metadata,
        outcome: 'salvaged',
        failure: salvagedChunk(chunk, salvaged, note, note, false),
      }
    }
    return { metadata: makeEmptyMetadata(), outcome: 'failed', failure: lostChunk(chunk, note) }
  }

  // A response that recovers whole is not worth re-asking for: the JSON was
  // malformed, the FACTS were all there. Take it and keep the 2.5 cents.
  if (salvaged.recovered > 0 && salvaged.dropped === 0) {
    runner.emit('info', `${label} map JSON was malformed but recovered whole (${detail}) -- no re-ask needed`)
    return {
      metadata: salvaged.metadata,
      outcome: 'salvaged',
      failure: salvagedChunk(chunk, salvaged, detail, parseError.message, false),
    }
  }

  if (runner.repair !== false) {
    runner.emit('warn', `${label} map JSON unparseable (${parseError.message}); ${detail} -- re-asking once`)
    const repaired = await tryRepair(runner, chunk, prompt, content)
    if (repaired) {
      runner.emit('info', `${label} repair re-ask parsed cleanly -- nothing lost`)
      return { metadata: repaired, outcome: 'parsed' }
    }
  }

  if (salvaged.recovered > 0) {
    runner.emit('warn', `${label} kept via salvage after the re-ask failed: ${detail}`)
    return {
      metadata: salvaged.metadata,
      outcome: 'salvaged',
      failure: salvagedChunk(chunk, salvaged, detail, parseError.message, runner.repair !== false),
    }
  }

  runner.emit('warn', `${label} LOST -- nothing recoverable: ${parseError.message}`)
  return {
    metadata: makeEmptyMetadata(),
    outcome: 'failed',
    failure: lostChunk(chunk, parseError.message, runner.repair !== false),
  }
}

/** One bite at the same chunk, with the malformed output fed back. Swallows a
 *  second parse failure (we fall through to salvage) but lets a transport error
 *  propagate -- a cancelled/timed-out repair means the run itself is over. */
async function tryRepair(
  runner: MapChunkRunner,
  chunk: TranscriptChunk,
  prompt: { system: string; user: string },
  content: string,
): Promise<RecapMetadata | null> {
  const repaired = await runner.call(
    'map-repair',
    {
      ...runner.request,
      // No timeout retry: this IS the second bite, and the map stage deadline is
      // budgeted for it exactly once.
      timeoutRetries: 0,
      retries: 1,
      temperature: 0,
      messages: [
        { role: 'system', content: prompt.system },
        { role: 'user', content: prompt.user },
        { role: 'assistant', content },
        { role: 'user', content: REPAIR_INSTRUCTION },
      ],
    },
    chunk.index,
  )
  try {
    return parseMapOutput(repaired)
  } catch (err) {
    if (!(err instanceof MapParseError)) throw err
    return null
  }
}
