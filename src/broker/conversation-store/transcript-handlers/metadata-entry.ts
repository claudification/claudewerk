import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptCustomTitleEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
} from '../../../shared/protocol'

/**
 * Top-level transcript entries that carry conversation metadata. Each one mutates
 * a single conversation field; returns true when something actually changed so
 * the orchestrator can trigger a conversation update.
 */

export function handleSummaryEntry(conversationId: string, conv: Conversation, entry: TranscriptSummaryEntry): boolean {
  const s = entry.summary
  if (typeof s !== 'string' || !s.trim()) return false
  conv.summary = s.trim()
  console.log(`[meta] summary: "${conv.summary.slice(0, 60)}" (conversation ${conversationId.slice(0, 8)})`)
  return true
}

export function handleCustomTitleEntry(
  conversationId: string,
  conv: Conversation,
  entry: TranscriptCustomTitleEntry,
): boolean {
  const t = entry.customTitle
  if (typeof t !== 'string' || !t.trim()) return false
  conv.title = t.trim()
  console.log(`[meta] title: "${conv.title}" (conversation ${conversationId.slice(0, 8)})`)
  return true
}

export function handleAgentNameEntry(
  conversationId: string,
  conv: Conversation,
  entry: TranscriptAgentNameEntry,
): boolean {
  const n = entry.agentName
  if (typeof n !== 'string' || !n.trim()) return false
  conv.agentName = n.trim()
  console.log(`[meta] agent: "${conv.agentName}" (conversation ${conversationId.slice(0, 8)})`)
  return true
}

export function handlePrLinkEntry(conversationId: string, conv: Conversation, entry: TranscriptPrLinkEntry): boolean {
  const { prNumber, prUrl, prRepository } = entry
  if (!prNumber || !prUrl) return false
  if (!conv.prLinks) conv.prLinks = []
  // Deduplicate by prUrl
  if (conv.prLinks.some(p => p.prUrl === prUrl)) return false
  conv.prLinks.push({
    prNumber,
    prUrl,
    prRepository: prRepository || '',
    timestamp: entry.timestamp || new Date().toISOString(),
  })
  console.log(
    `[meta] pr-link: ${prRepository}#${prNumber} (conversation ${conversationId.slice(0, 8)}, total: ${conv.prLinks.length})`,
  )
  return true
}
