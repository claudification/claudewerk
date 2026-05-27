import type { Conversation, TranscriptAssistantEntry } from '../../../shared/protocol'

/**
 * Per-assistant-entry processing: tool count, model fallback, token usage
 * extraction, cost timeline (PTY only). Skips `<synthetic>` assistant
 * blocks (auto-compact summaries, recap, hook-injected) since they aren't
 * real API turns.
 *
 * Returns true when usage was extracted (which mutates lots of stats).
 */
export function handleAssistantEntry(conv: Conversation, entry: TranscriptAssistantEntry): boolean {
  const content = entry.message?.content
  if (Array.isArray(content)) {
    conv.stats.toolCallCount += content.filter(c => c.type === 'tool_use').length
  }

  // Init message (conversation.model) is ground truth. Assistant messages strip
  // context-window suffixes like [1m], so only use as a last-resort fallback.
  const assistantModel = entry.message?.model
  if (typeof assistantModel === 'string' && assistantModel !== '<synthetic>' && !conv.model) {
    conv.model = assistantModel
  }

  return extractUsage(conv, entry, assistantModel)
}

function extractUsage(
  conv: Conversation,
  entry: TranscriptAssistantEntry,
  assistantModel: string | undefined,
): boolean {
  const usage = entry.message?.usage
  if (!usage || typeof usage.input_tokens !== 'number' || assistantModel === '<synthetic>') return false

  conv.tokenUsage = {
    input: usage.input_tokens || 0,
    cacheCreation: usage.cache_creation_input_tokens || 0,
    cacheRead: usage.cache_read_input_tokens || 0,
    output: usage.output_tokens || 0,
  }

  // Extract 5m/1h cache write split from usage.cache_creation
  const cc = usage.cache_creation
  const cw5m = (cc?.ephemeral_5m_input_tokens as number | undefined) || 0
  const cw1h = (cc?.ephemeral_1h_input_tokens as number | undefined) || 0
  // Fallback: if total cache_creation > sum of 5m+1h, remainder -> 5m bucket
  const cwTotal = usage.cache_creation_input_tokens || 0
  const cwRemainder = Math.max(0, cwTotal - cw5m - cw1h)

  if (cw5m + cwRemainder > 0 || cw1h > 0) {
    conv.cacheTtl = cw1h > cw5m + cwRemainder ? '1h' : '5m'
  }

  conv.stats.totalInputTokens += (usage.input_tokens || 0) + cwTotal + (usage.cache_read_input_tokens || 0)
  conv.stats.totalOutputTokens += usage.output_tokens || 0
  conv.stats.totalCacheCreation += cwTotal
  conv.stats.totalCacheWrite5m += cw5m + cwRemainder
  conv.stats.totalCacheWrite1h += cw1h
  conv.stats.totalCacheRead += usage.cache_read_input_tokens || 0

  // Cost timeline snapshot for PTY conversations (headless uses turn_cost from stream backend)
  if (!conv.stats.totalCostUsd) {
    if (!conv.costTimeline) conv.costTimeline = []
    const s = conv.stats
    const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
    const est =
      (uncached * 15 +
        s.totalOutputTokens * 75 +
        s.totalCacheRead * 1.875 +
        s.totalCacheWrite5m * 18.75 +
        s.totalCacheWrite1h * 30) /
      1_000_000
    conv.costTimeline.push({ t: Date.now(), cost: est })
    if (conv.costTimeline.length > 500) {
      conv.costTimeline = conv.costTimeline.slice(-500)
    }
  }

  return true
}

export interface PerMessageTokenSample {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/**
 * Extract the RAW per-message token usage from an assistant entry for the
 * token-flow time-series (token_samples). Returns null for `<synthetic>` blocks
 * (auto-compact summaries, recap, hook-injected) and entries with no usage --
 * the same guards as extractUsage. Values are PER-MESSAGE (one API response),
 * NOT the cumulative `conv.stats.total*`. The caller persists one sample per
 * assistant message; (conversation_id, uuid) de-dups re-reads + backfill.
 */
function numOr0(v: unknown): number {
  return typeof v === 'number' ? v : 0
}

function resolveSampleModel(model: string | undefined, conv: Conversation): string {
  if (typeof model === 'string' && model.length > 0) return model
  return conv.model || ''
}

export function perMessageTokenSample(
  conv: Conversation,
  entry: TranscriptAssistantEntry,
): PerMessageTokenSample | null {
  const usage = entry.message?.usage
  const model = entry.message?.model
  if (!usage || typeof usage.input_tokens !== 'number' || model === '<synthetic>') return null
  return {
    model: resolveSampleModel(model, conv),
    inputTokens: numOr0(usage.input_tokens),
    outputTokens: numOr0(usage.output_tokens),
    cacheReadTokens: numOr0(usage.cache_read_input_tokens),
    cacheWriteTokens: numOr0(usage.cache_creation_input_tokens),
  }
}
