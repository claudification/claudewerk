import type { RecapAudience } from '../../../../shared/protocol'

// OpenRouter slugs (pinned, like the broker's other recap models). Human recaps
// default to Opus -- the rich, fully-cited report needs the strongest judgment
// and prose. Agent briefs stay on Sonnet (good judgment at lower cost). Both are
// overridable via env for cost tuning without a code change. CLAUDWERK_ is the
// canonical prefix (RCLAUDE_ legacy fallback).
const SONNET_MODEL = 'anthropic/claude-sonnet-5'
// Opus 4.8, NOT Opus 5 -- and that is a measurement, not conservatism.
//
// Opus 5 was briefly the default on the theory that identical list pricing made
// it a free capability upgrade. Replaying the real reduce prompt proved
// otherwise: Opus 5 is markedly more verbose, ran into the 32k output cap and
// returned a document that stops MID-SENTENCE, for $1.267/run against 4.8's
// $0.894 (+42%). A blind judge holding the complete source-fact inventory then
// ranked 4.8 first overall and marked Opus 5 down to 4/10 on structure for the
// truncation. Price-card reasoning is not measurement; revisit only with a
// higher output cap and fresh numbers.
const OPUS_MODEL = 'anthropic/claude-opus-4.8'

const HUMAN_MODEL = process.env.CLAUDWERK_RECAP_HUMAN_MODEL || process.env.RCLAUDE_RECAP_HUMAN_MODEL || OPUS_MODEL
const AGENT_MODEL = process.env.CLAUDWERK_RECAP_AGENT_MODEL || process.env.RCLAUDE_RECAP_AGENT_MODEL || SONNET_MODEL

// Chunked map-reduce model defaults (Pillar A). Map = cheap parallel extraction
// (Sonnet), reduce = the strong synthesis/judgment pass (Opus). Both env-tunable
// and per-call overridable (Pillar D) -- pinned here so all recap model slugs
// live in ONE file. The map model being ~5x cheaper on input than reduce is the
// whole point: stop paying Opus for raw transcript bulk.
//
// MEASURED, do not re-litigate without new numbers (2026-07-27): Haiku 4.5 was
// evaluated against Sonnet 5 for the map stage on a real conversation through
// the real map prompt, 3 runs each. Both parsed 3/3, but Haiku extracted ~40%
// fewer items (avg 8.0 vs 13.3) and far fewer list values (23 flat, every run,
// vs 54-113). Haiku is only 2x cheaper ($1/$5 per M vs $2/$10) -- and since the
// cross-run map cache landed, the whole nightly map stage is ~$0.25, so the swap
// saves roughly $4/month in exchange for permanently thinner extraction. Worse,
// extractions are CACHED for 60 days, so a quality regression here is sticky.
// Not worth it. (Haiku was ~3x faster; irrelevant now the cache removed the
// wall-clock pressure.)
const MAP_MODEL = process.env.CLAUDWERK_RECAP_MAP_MODEL || process.env.RCLAUDE_RECAP_MAP_MODEL || SONNET_MODEL

/**
 * The synthesis (reduce) model is TIERED, because the two kinds of recap have
 * genuinely different stakes.
 *
 * PREMIUM (Opus 4.8) -- a person asked for this, or it is customer-facing. It
 * gets read by a human who will judge it, so it gets the best synthesis we have.
 *
 * ECONOMY (GLM-5.2) -- an unattended scheduled run feeding the searchable
 * knowledge layer. Nobody reads it as prose; it is machinery.
 *
 * MEASURED (2026-07-27), replaying the real 93k-token reduce prompt and judging
 * blind against the complete source-fact inventory, two judges from different
 * families:
 *   opus-4.8   8.6  $0.894  clean
 *   glm-5.2    8.2  $0.091  clean            <- 90% cheaper, 0.4 behind
 *   minimax-m3 6.8  $0.056  FABRICATES       <- cheapest, and it invents tools
 *   gpt-5.1    5.6  $0.181  whole threads missing
 *   deepseek-v4-pro / kimi-k2.6  unparseable (no YAML frontmatter)
 *
 * GLM-5.2's deficit is thinner coverage on a few threads, not accuracy -- an
 * acceptable trade for machinery at a tenth the price. minimax-m3 was rejected
 * DESPITE being cheapest: it invented tool names (`mathias-grep`, `findme`), an
 * endpoint, and a test framework this project does not use, all verified absent
 * from the source. A confident falsehood in a durable record is worse than an
 * omission, and cheaper is not a defence.
 */
const REDUCE_MODEL_PREMIUM =
  process.env.CLAUDWERK_RECAP_REDUCE_MODEL || process.env.RCLAUDE_RECAP_REDUCE_MODEL || OPUS_MODEL
const REDUCE_MODEL_ECONOMY = process.env.CLAUDWERK_RECAP_REDUCE_MODEL_ECONOMY || 'z-ai/glm-5.2'

export type RecapTier = 'premium' | 'economy'

/** What decides the tier. Deliberately NOT `audience`: a user can ask for an
 *  agent-audience brief and should still get the premium synthesis. The question
 *  is who is waiting for it, not who it is addressed to. */
export interface TierInputs {
  /** Machine-scheduled with nobody waiting on it (see isUnattendedRun). */
  unattended: boolean
  /** Rendered for someone outside the team -- always premium, scheduled or not. */
  customerFriendly?: boolean
}

export function resolveTier(inputs: TierInputs): RecapTier {
  // Customer-facing wins outright. A scheduled customer-facing recap is still
  // going in front of someone who did not ask to read machine output.
  if (inputs.customerFriendly) return 'premium'
  return inputs.unattended ? 'economy' : 'premium'
}

export function reduceModelForTier(tier: RecapTier): string {
  return tier === 'economy' ? REDUCE_MODEL_ECONOMY : REDUCE_MODEL_PREMIUM
}

export interface ChunkModels {
  mapModel: string
  reduceModel: string
}

/** Resolve the chunked map/reduce models. An explicit per-call override (Pillar
 *  D / the eval harness) beats the tier; the tier beats the default. */
export function chunkModels(overrides?: Partial<ChunkModels>, tier: RecapTier = 'premium'): ChunkModels {
  return {
    mapModel: overrides?.mapModel || MAP_MODEL,
    reduceModel: overrides?.reduceModel || reduceModelForTier(tier),
  }
}

// Opus has a 1M-token context window, so we DON'T downgrade large human
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
