import type { RecapAudience } from '../../../../shared/protocol'

// OpenRouter slugs (pinned, like the broker's other recap models). Human recaps
// default to Opus -- the rich, fully-cited report needs the strongest judgment
// and prose. Agent briefs stay on Sonnet (good judgment at lower cost). Both are
// overridable via env for cost tuning without a code change. CLAUDWERK_ is the
// canonical prefix (RCLAUDE_ legacy fallback).
const SONNET_MODEL = 'anthropic/claude-sonnet-4'
const OPUS_MODEL = 'anthropic/claude-opus-4.8'

const HUMAN_MODEL = process.env.CLAUDWERK_RECAP_HUMAN_MODEL || process.env.RCLAUDE_RECAP_HUMAN_MODEL || OPUS_MODEL
const AGENT_MODEL = process.env.CLAUDWERK_RECAP_AGENT_MODEL || process.env.RCLAUDE_RECAP_AGENT_MODEL || SONNET_MODEL

// Chunked map-reduce model defaults (Pillar A). Map = cheap parallel extraction
// (Sonnet), reduce = the strong synthesis/judgment pass (Opus). Both env-tunable
// and per-call overridable (Pillar D) -- pinned here so all recap model slugs
// live in ONE file. The map model being ~5x cheaper on input than reduce is the
// whole point: stop paying Opus for raw transcript bulk.
const MAP_MODEL = process.env.CLAUDWERK_RECAP_MAP_MODEL || process.env.RCLAUDE_RECAP_MAP_MODEL || SONNET_MODEL
const REDUCE_MODEL = process.env.CLAUDWERK_RECAP_REDUCE_MODEL || process.env.RCLAUDE_RECAP_REDUCE_MODEL || OPUS_MODEL

export interface ChunkModels {
  mapModel: string
  reduceModel: string
}

/** Resolve the chunked map/reduce models (env defaults; Pillar D overrides them
 *  per-call upstream). One source of truth for the chunked-path model slugs. */
export function chunkModels(overrides?: Partial<ChunkModels>): ChunkModels {
  return {
    mapModel: overrides?.mapModel || MAP_MODEL,
    reduceModel: overrides?.reduceModel || REDUCE_MODEL,
  }
}

// Opus 4.8 has a 1M-token context window, so we DON'T downgrade large human
// recaps -- we eat the cost and use the big-context model (Jonas's call). This
// ceiling only catches inputs that would blow past ~1M tokens even for Opus:
// ~3.2M chars leaves headroom for the 8k-token output + tokenizer slack
// (~3.7 chars/token). Above it we fall back to Sonnet as a best-effort safety
// valve -- the real fix for genuinely-huge periods is the deferred chunk-and-
// merge phase (per-chunk verbose recaps -> recap-the-recaps; see
// plan-recap-2.0.md "Deferred: chunked map-reduce recaps").
const CHUNK_CEILING_CHARS = 3_200_000

export interface ModelChoice {
  model: string
  reason: 'human-floor' | 'agent-floor' | 'too-big'
}

export function pickModel(inputChars: number, audience: RecapAudience = 'human'): ModelChoice {
  if (inputChars > CHUNK_CEILING_CHARS) return { model: SONNET_MODEL, reason: 'too-big' }
  if (audience === 'agent') return { model: AGENT_MODEL, reason: 'agent-floor' }
  return { model: HUMAN_MODEL, reason: 'human-floor' }
}
