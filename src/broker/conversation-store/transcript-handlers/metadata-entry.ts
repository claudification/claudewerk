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
  const summary = s.trim()
  if (conv.summary === summary) return false
  conv.summary = summary
  console.log(`[meta] summary: "${conv.summary.slice(0, 60)}" (conversation ${conversationId.slice(0, 8)})`)
  return true
}

/**
 * CC's own title, read off its JSONL `custom-title` control line.
 *
 * `isInitial` marks a REPLAY -- a resync (broker restart, host reconnect,
 * revive, truncation recovery) re-sends the whole transcript, and
 * `stream-replay.ts` deliberately hoists metadata entries past the 500-entry
 * truncation, so this stale line arrives on EVERY reconnect. It carries the
 * name CC knows: the launch name, older than any rename made since. Applying it
 * blindly is what dragged renamed conversations back to their launch name after
 * a broker restart (2026-07-28: 3242 clobbers across ~40 conversations in one
 * boot). A replay may FILL an unpinned title; it may never overwrite a pinned
 * one. A LIVE entry (`/rename` typed inside CC) is a fresh user action and
 * still wins -- same rule the `conversation_name` wire handler already applies.
 */
export function handleCustomTitleEntry(
  conversationId: string,
  conv: Conversation,
  entry: TranscriptCustomTitleEntry,
  isInitial: boolean,
): boolean {
  const t = entry.customTitle
  if (typeof t !== 'string' || !t.trim()) return false
  const title = t.trim()
  if (conv.title === title) return false
  if (isInitial && conv.titleUserSet) {
    console.log(
      `[meta] title: replayed "${title}" ignored -- user-set title "${conv.title}" preserved ` +
        `(conversation ${conversationId.slice(0, 8)})`,
    )
    return false
  }
  conv.title = title
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
  const agentName = n.trim()
  if (conv.agentName === agentName) return false
  conv.agentName = agentName
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
