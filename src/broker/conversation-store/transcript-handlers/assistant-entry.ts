import type { Conversation, TranscriptAssistantEntry } from '../../../shared/protocol'
import { type PerMessageTokenSample, sampleFromMessageUsage } from '../../../shared/token-usage'

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
  // One parse via the shared extractor: it coerces every field and applies the
  // real 5m/1h split, so the aggregate here and the token_samples time-series
  // can never disagree. Null on synthetic / usage-less blocks.
  const u = sampleFromMessageUsage(entry.message?.usage, assistantModel, conv.model || '')
  if (!u) return false
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens: cwTotal } = u
  const { cacheWrite5mTokens: cw5m, cacheWrite1hTokens: cw1h } = u

  conv.tokenUsage = { input: inputTokens, cacheCreation: cwTotal, cacheRead: cacheReadTokens, output: outputTokens }

  if (cw5m > 0 || cw1h > 0) conv.cacheTtl = cw1h > cw5m ? '1h' : '5m'

  conv.stats.totalInputTokens += inputTokens + cwTotal + cacheReadTokens
  conv.stats.totalOutputTokens += outputTokens
  conv.stats.totalCacheCreation += cwTotal
  conv.stats.totalCacheWrite5m += cw5m
  conv.stats.totalCacheWrite1h += cw1h
  conv.stats.totalCacheRead += cacheReadTokens

  pushPtyCostEstimate(conv)
  return true
}

/**
 * Append a running cost estimate to the PTY cost timeline. Headless
 * conversations get exact cost via `turn_cost` from the stream backend, so this
 * only runs when no exact total is present. Uses the real 5m/1h write split for
 * the re-warm tax (18.75 vs 30 per Mtok).
 */
function pushPtyCostEstimate(conv: Conversation): void {
  if (conv.stats.totalCostUsd) return
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

/**
 * Per-message token sample from an assistant entry for the token-flow
 * time-series (token_samples). Thin wrapper over the shared
 * `sampleFromMessageUsage` -- falls back to the conversation's model when the
 * message has none. Returns null for synthetic / usage-less entries. The caller
 * persists one sample per assistant message; (conversation_id, uuid) de-dups
 * re-reads + backfill.
 */
export function perMessageTokenSample(
  conv: Conversation,
  entry: TranscriptAssistantEntry,
): PerMessageTokenSample | null {
  return sampleFromMessageUsage(entry.message?.usage, entry.message?.model, conv.model || '')
}
