/**
 * Compute USD cost for an LLM round-trip from token usage. Reuses the
 * broker's LiteLLM-backed pricing table (`src/broker/model-pricing.ts`).
 *
 * If the OpenRouter response includes its own `usage.cost` field we
 * trust that (some models surface it). Otherwise we look up rates from
 * LiteLLM and multiply.
 */

import { getModelInfo } from '../../model-pricing'

export interface OpenRouterUsage {
  prompt_tokens?: number
  completion_tokens?: number
  total_tokens?: number
  cost?: number
  prompt_tokens_details?: {
    cached_tokens?: number
  }
  cache_creation_input_tokens?: number
  /** OpenRouter's billed-cost breakdown (only present with usage.include).
   *  The input-vs-output split is the real optimization signal for chunking:
   *  it shows how much of the spend was raw-input bulk vs generation. */
  cost_details?: {
    upstream_inference_prompt_cost?: number
    upstream_inference_completions_cost?: number
  }
}

export interface TokenCounts {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface NormalizedUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  costUsd: number
  costSource: 'openrouter' | 'litellm' | 'unknown'
  /** Billed cost split into input (prompt) vs output (completion) when
   *  OpenRouter's cost_details is present. Undefined for litellm-estimated
   *  or older responses. The chunking thesis ("stop paying the expensive
   *  model for raw input bulk") is measured here. */
  inputCostUsd?: number
  outputCostUsd?: number
}

export function normalizeUsage(model: string, usage: OpenRouterUsage | undefined): NormalizedUsage {
  const counts = extractTokenCounts(usage)
  const cost = pickCost(model, counts, usage)
  const split = extractCostSplit(usage)
  return { ...counts, costUsd: cost.amount, costSource: cost.source, ...split }
}

/** Pull the input/output cost split out of OpenRouter's cost_details, when
 *  present. Returns an empty object otherwise so the fields stay undefined. */
// fallow-ignore-next-line complexity
function extractCostSplit(usage: OpenRouterUsage | undefined): { inputCostUsd?: number; outputCostUsd?: number } {
  const d = usage?.cost_details
  if (!d) return {}
  const input = d.upstream_inference_prompt_cost
  const output = d.upstream_inference_completions_cost
  return {
    ...(typeof input === 'number' ? { inputCostUsd: input } : {}),
    ...(typeof output === 'number' ? { outputCostUsd: output } : {}),
  }
}

type FullCounts = Required<TokenCounts>

const ZERO_COUNTS: FullCounts = { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }

function extractTokenCounts(usage: OpenRouterUsage | undefined): FullCounts {
  if (!usage) return ZERO_COUNTS
  return {
    inputTokens: numberOr(usage.prompt_tokens, 0),
    outputTokens: numberOr(usage.completion_tokens, 0),
    cacheReadTokens: numberOr(usage.prompt_tokens_details?.cached_tokens, 0),
    cacheWriteTokens: numberOr(usage.cache_creation_input_tokens, 0),
  }
}

function numberOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' ? value : fallback
}

function pickCost(
  model: string,
  counts: FullCounts,
  usage: OpenRouterUsage | undefined,
): { amount: number; source: NormalizedUsage['costSource'] } {
  if (typeof usage?.cost === 'number' && Number.isFinite(usage.cost)) {
    return { amount: usage.cost, source: 'openrouter' }
  }
  return computeCostUsd(model, counts)
}

export function computeCostUsd(model: string, tokens: TokenCounts): { amount: number; source: 'litellm' | 'unknown' } {
  const info = getModelInfo(stripOpenRouterVendor(model))
  if (!info) return { amount: 0, source: 'unknown' }
  const cacheRead = info.cacheReadCostPerToken ?? info.inputCostPerToken
  const cacheWrite = info.cacheWriteCostPerToken ?? info.inputCostPerToken
  const amount =
    numberOr(tokens.inputTokens, 0) * info.inputCostPerToken +
    numberOr(tokens.outputTokens, 0) * info.outputCostPerToken +
    numberOr(tokens.cacheReadTokens, 0) * cacheRead +
    numberOr(tokens.cacheWriteTokens, 0) * cacheWrite
  return { amount, source: 'litellm' }
}

function stripOpenRouterVendor(slug: string): string {
  const idx = slug.indexOf('/')
  return idx === -1 ? slug : slug.slice(idx + 1)
}
