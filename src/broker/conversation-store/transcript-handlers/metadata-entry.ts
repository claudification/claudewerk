import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptCustomTitleEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
} from '../../../shared/protocol'
import { applyTitleWrite } from '../title-authority'

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
 * This is the weakest title writer there is, and `title-authority` ranks it as
 * `cc-observed` for two reasons:
 *
 * 1. It is STALE by construction. Every resync (broker restart, host reconnect,
 *    revive, truncation recovery) re-sends the transcript, and `stream-replay.ts`
 *    deliberately hoists metadata entries past the 500-entry truncation so this
 *    line arrives on EVERY reconnect carrying whatever CC last wrote. Applying it
 *    dragged renamed conversations back to their launch name (2026-07-28: 3242
 *    clobbers across ~40 conversations in a single boot).
 * 2. It is UNDATED. The line is `{type, customTitle, sessionId}` and nothing
 *    else -- no uuid, no timestamp -- so it cannot even be compared against a
 *    newer write. Origin is the only thing that can hold it back.
 *
 * Gating on `isInitial` was tried and is NOT sufficient: a replay is chunked and
 * `sendTranscriptEntriesChunked` sets `isInitial` on the FIRST chunk only
 * (transcript-manager.ts), so a `custom-title` landing in any later chunk looks
 * live. There is no trustworthy per-entry "is this a replay" bit and this file
 * no longer pretends there is.
 *
 * It is still allowed to title an UNPINNED conversation, because CC's auto-titler
 * has no other channel to reach us through. A live `/rename` typed inside CC is a
 * different thing entirely -- the agent host detects it and sends a DATED `user`
 * write, which outranks this one.
 */
export function handleCustomTitleEntry(
  conversationId: string,
  conv: Conversation,
  entry: TranscriptCustomTitleEntry,
): boolean {
  const t = entry.customTitle
  if (typeof t !== 'string' || !t.trim()) return false

  const verdict = applyTitleWrite(conv, { title: t.trim(), origin: 'cc-observed' }, Date.now())
  if (!verdict.accept) {
    if (verdict.reason !== 'unchanged') {
      console.log(
        `[meta] title: transcript "${t.trim()}" ignored (${verdict.reason}) -- "${conv.title}" ` +
          `origin=${conv.titleOrigin ?? '-'} preserved (conversation ${conversationId.slice(0, 8)})`,
      )
    }
    return false
  }
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
