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
}

/** The subset of an assistant message's `usage` block we care about. */
export interface MessageUsage {
  input_tokens?: number
  output_tokens?: number
  cache_read_input_tokens?: number
  cache_creation_input_tokens?: number
}

function numOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0
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
  return {
    model: typeof model === 'string' && model.length > 0 ? model : fallbackModel,
    inputTokens: numOr0(usage.input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    cacheReadTokens: numOr0(usage.cache_read_input_tokens),
    cacheWriteTokens: numOr0(usage.cache_creation_input_tokens),
  }
}
