/**
 * Pure extraction of RAW per-message token usage from an assistant message's
 * `usage` block, for the token-flow time-series (token_samples).
 *
 * Shared by BOTH live ingest (broker/conversation-store/transcript-handlers/
 * assistant-entry.ts) and the one-shot backfill (broker/store/sqlite/tokens.ts)
 * so the two paths can never drift. Depends only on the protocol usage shape --
 * no broker or store types -- so either layer can import it cleanly.
 */

export interface PerMessageTokenSample {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  /** 5m-TTL portion of cacheWriteTokens (ephemeral prompt-cache re-warm). */
  cacheWrite5mTokens: number
  /** 1h-TTL portion of cacheWriteTokens. */
  cacheWrite1hTokens: number
}

/** The subset of an assistant message's `usage` block we care about. */
export interface MessageUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
  /** Real per-TTL split of cache_creation_input_tokens
   *  (`ephemeral_5m_input_tokens` / `ephemeral_1h_input_tokens`). Present on
   *  recent CC / Anthropic API responses; absent on older transcripts. */
  cache_creation?: Record<string, number>
}

function numOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

/**
 * Split cache-creation (write) tokens into their real 5m / 1h TTL buckets from
 * the `usage.cache_creation` sub-object -- KNOWN, not guessed. When that
 * sub-object is absent (older transcripts) the whole total falls to the 5m
 * bucket; any rounding gap between the reported total and the two named buckets
 * is folded into 5m so `cw5m + cw1h === cache_creation_input_tokens` exactly.
 *
 * Single source of truth: both the per-message time-series (token_samples) and
 * the per-conversation aggregate (conv.stats) call this, so they can't drift.
 */
export function splitCacheCreation(usage: MessageUsage): {
  cacheWrite5mTokens: number
  cacheWrite1hTokens: number
} {
  const cc = usage.cache_creation
  const cw5m = numOr0(cc?.ephemeral_5m_input_tokens)
  const cw1h = numOr0(cc?.ephemeral_1h_input_tokens)
  const total = numOr0(usage.cache_creation_input_tokens)
  const remainder = Math.max(0, total - cw5m - cw1h)
  return { cacheWrite5mTokens: cw5m + remainder, cacheWrite1hTokens: cw1h }
}

/**
 * Returns null for `<synthetic>` blocks (auto-compact summaries, recap,
 * hook-injected) and messages with no real usage. `fallbackModel` is used when
 * the message carries no model string (stripped). Values are PER-MESSAGE (one
 * API response), NOT cumulative.
 */
export function sampleFromMessageUsage(
  usage: MessageUsage | undefined,
  model: string | undefined,
  fallbackModel: string,
): PerMessageTokenSample | null {
  if (!usage || typeof usage.input_tokens !== 'number' || model === '<synthetic>') return null
  const { cacheWrite5mTokens, cacheWrite1hTokens } = splitCacheCreation(usage)
  return {
    model: typeof model === 'string' && model.length > 0 ? model : fallbackModel,
    inputTokens: numOr0(usage.input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    cacheReadTokens: numOr0(usage.cache_read_input_tokens),
    cacheWriteTokens: numOr0(usage.cache_creation_input_tokens),
    cacheWrite5mTokens,
    cacheWrite1hTokens,
  }
}
