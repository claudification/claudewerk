import type {
  Conversation,
  TranscriptAgentNameEntry,
  TranscriptAssistantEntry,
  TranscriptCustomTitleEntry,
  TranscriptEntry,
  TranscriptPrLinkEntry,
  TranscriptSummaryEntry,
  TranscriptSystemEntry,
  TranscriptUserEntry,
} from '../../shared/protocol'
import { agentScopeOf } from './agent-scope'
import { MAX_TRANSCRIPT_ENTRIES } from './constants'
import { assignTranscriptSeqs, type ConversationStoreContext } from './event-context'
import { persistTranscriptEntries, resolveEntryTimestamp } from './persist-transcript'
import { handleAssistantEntry, perMessageTokenSample } from './transcript-handlers/assistant-entry'
import { detectBgTaskNotifications } from './transcript-handlers/bg-task-notifications'
import { handleMentionNotifications } from './transcript-handlers/mention-notify'
import {
  handleAgentNameEntry,
  handleCustomTitleEntry,
  handlePrLinkEntry,
  handleSummaryEntry,
} from './transcript-handlers/metadata-entry'
import { extractLiveSubagentEntries } from './transcript-handlers/subagent-extraction'
import { handleSystemEntry } from './transcript-handlers/system-entry'
import { handleUserEntry } from './transcript-handlers/user-entry'

/**
 * Persist a batch of transcript entries to the cache + derive conversation-level
 * stats / metadata from them. Re-broadcasts compaction markers and live
 * subagent transcripts. No-op when the conversation isn't registered.
 *
 * Thin orchestrator: cache + seq stamping + dirty flag + stats reset live
 * here, plus post-loop scans for bg-task notifications and live subagent
 * transcripts. Per-entry-type work delegates to typed helpers under
 * `transcript-handlers/`, dispatched through the `entryHandlers` table
 * below. Each helper returns `boolean` indicating whether conversation metadata
 * changed so the orchestrator can decide if a conversation update is warranted.
 */
export function addTranscriptEntries(
  ctx: ConversationStoreContext,
  conversationId: string,
  incoming: TranscriptEntry[],
  isInitial: boolean,
): void {
  // Scope guard (Checkpoint A): this is the PARENT ingest (`agent_id IS NULL`).
  // The transcript handler already diverts agent-scoped entries, but any other
  // caller (or a future code path) that hands us a mixed batch must not pollute
  // the parent scope. Strip anything carrying an agent discriminant -- it has
  // already been (or will be) routed to its sub-scope by the diverting handler.
  const entries = incoming.filter(e => agentScopeOf(e) === null)
  if (entries.length !== incoming.length) {
    console.warn(
      `[transcript-store] scope guard stripped ${incoming.length - entries.length} agent-scoped entr(ies) from the parent ingest of ${conversationId.slice(0, 8)} (stale host re-leak?)`,
    )
    // Batch was ENTIRELY agent chatter -- nothing belongs in the parent scope.
    // (An originally-empty batch still falls through so its isInitial stats
    // reset is preserved.)
    if (entries.length === 0) return
  }

  // Stamp seqs BEFORE cache insert and BEFORE any broadcast the caller does.
  // All entries in `entries` are mutated in place with `entry.seq = N`.
  // Callers (handlers/transcript.ts, handlers/boot-lifecycle.ts) then
  // broadcast the same objects, so the wire payload carries seqs too.
  assignTranscriptSeqs(ctx.transcriptSeqCounters, conversationId, entries, isInitial)
  appendToCache(ctx, conversationId, entries, isInitial)
  persistToStore(ctx, conversationId, entries)
  ctx.dirtyTranscripts.add(conversationId)

  const conv = ctx.conversations.get(conversationId)
  if (!conv) return

  if (!conv.stats || isInitial) resetConversationMetadataAndStats(conv, isInitial)

  let conversationChanged = false
  for (const entry of entries) {
    // gitBranch lives on the base type and applies to any entry
    if (!conv.gitBranch && entry.gitBranch) {
      conv.gitBranch = entry.gitBranch
      conversationChanged = true
    }

    if (entryHandlers[entry.type]?.(ctx, conversationId, conv, entry, isInitial)) {
      conversationChanged = true
    }
  }

  // Post-loop scans: bg task completion + live subagent extraction
  if (detectBgTaskNotifications(conv, entries)) conversationChanged = true
  extractLiveSubagentEntries(ctx, conversationId, entries)

  if (conversationChanged) ctx.scheduleConversationUpdate(conversationId)
}

// ─── per-entry-type dispatch table ─────────────────────────────────────────
//
// Each entry adapts a typed transcript-handler helper to the uniform
// `TranscriptEntryHandler` signature so the orchestrator can dispatch
// through a `Record<entryType, TranscriptEntryHandler>`. The narrow cast
// happens once at the boundary in each adapter; the helpers themselves
// work with the narrow type. Each adapter returns `true` when conversation
// metadata mutated, so the orchestrator can OR the results and decide
// whether to schedule a conversation update.

type TranscriptEntryHandler = (
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
) => boolean

function dispatchCompacted(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  _entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  conv.stats.compactionCount++
  return false
}

function dispatchUserEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleUserEntry(ctx, conversationId, conv, entry as TranscriptUserEntry, isInitial)
}

function dispatchAssistantEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  const assistantEntry = entry as TranscriptAssistantEntry
  const changed = handleAssistantEntry(conv, assistantEntry)
  recordTokenSample(ctx, conversationId, conv, assistantEntry, isInitial)
  handleMentionNotifications(ctx, conv, assistantEntry, isInitial)
  return changed
}

/**
 * Persist one per-message token sample to the token_samples time-series (powers
 * the live token-flow widget) and broadcast it live. One row per assistant API
 * response; the store INSERT OR IGNOREs on (conversation_id, uuid) so isInitial
 * full-file re-reads (reconnect/restart) and the Phase-3 backfill never
 * double-count. Requires a uuid -- without one we can't de-dup, so we skip
 * rather than risk inflation.
 *
 * The live `token_sample` broadcast fires ONLY for newly-inserted (non-dup)
 * samples AND only when !isInitial -- so a full-file re-read never replays
 * history onto the live widget. The broker emits it globally (project '*',
 * gated by chat:read on '*'); reconnecting clients re-seed from the REST window
 * query, so no replay buffer is needed. Failures are swallowed: token stats
 * must never break transcript ingest.
 */
function recordTokenSample(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptAssistantEntry,
  isInitial: boolean,
): void {
  if (!ctx.store || !entry.uuid) return
  const sample = perMessageTokenSample(conv, entry)
  if (!sample) return
  const timestamp = resolveEntryTimestamp(entry.timestamp)
  try {
    const inserted = ctx.store.tokens.recordSample({
      uuid: entry.uuid,
      timestamp,
      conversationId,
      sentinelId: conv.hostSentinelId,
      profile: conv.resolvedProfile,
      model: sample.model,
      inputTokens: sample.inputTokens,
      outputTokens: sample.outputTokens,
      cacheReadTokens: sample.cacheReadTokens,
      cacheWriteTokens: sample.cacheWriteTokens,
    })
    if (inserted && !isInitial) {
      ctx.broadcastConversationScoped(
        {
          type: 'token_sample',
          conversationId,
          timestamp,
          sentinelId: conv.hostSentinelId,
          profile: conv.resolvedProfile || 'default',
          model: sample.model,
          inputTokens: sample.inputTokens,
          outputTokens: sample.outputTokens,
          cacheReadTokens: sample.cacheReadTokens,
          cacheWriteTokens: sample.cacheWriteTokens,
        },
        '*',
      )
    }
  } catch (err) {
    console.error('[token-samples] recordSample failed:', err instanceof Error ? err.message : err)
  }
}

function dispatchSystemEntry(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  isInitial: boolean,
): boolean {
  return handleSystemEntry(ctx, conversationId, conv, entry as TranscriptSystemEntry, isInitial)
}

function dispatchSummaryEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleSummaryEntry(conversationId, conv, entry as TranscriptSummaryEntry)
}

function dispatchCustomTitleEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleCustomTitleEntry(conversationId, conv, entry as TranscriptCustomTitleEntry)
}

function dispatchAgentNameEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handleAgentNameEntry(conversationId, conv, entry as TranscriptAgentNameEntry)
}

function dispatchPrLinkEntry(
  _ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  entry: TranscriptEntry,
  _isInitial: boolean,
): boolean {
  return handlePrLinkEntry(conversationId, conv, entry as TranscriptPrLinkEntry)
}

const entryHandlers: Record<string, TranscriptEntryHandler> = {
  compacted: dispatchCompacted,
  user: dispatchUserEntry,
  assistant: dispatchAssistantEntry,
  system: dispatchSystemEntry,
  summary: dispatchSummaryEntry,
  'custom-title': dispatchCustomTitleEntry,
  'agent-name': dispatchAgentNameEntry,
  'pr-link': dispatchPrLinkEntry,
}

/** Persist parent-scope (`agent_id IS NULL`) transcript entries. The shared
 *  helper does the orphan guard, uuid synthesis, scope tagging, and error
 *  swallowing -- this thin wrapper just supplies the orphan-guard predicate. */
function persistToStore(ctx: ConversationStoreContext, conversationId: string, entries: TranscriptEntry[]): void {
  persistTranscriptEntries(ctx.store, ctx.conversations.has(conversationId), conversationId, entries)
}

function appendToCache(
  ctx: ConversationStoreContext,
  conversationId: string,
  entries: TranscriptEntry[],
  isInitial: boolean,
): void {
  if (isInitial) {
    ctx.transcriptCache.set(conversationId, entries.slice(-MAX_TRANSCRIPT_ENTRIES))
    return
  }
  const existing = ctx.transcriptCache.get(conversationId) || []
  existing.push(...entries)
  if (existing.length > MAX_TRANSCRIPT_ENTRIES) {
    ctx.transcriptCache.set(conversationId, existing.slice(-MAX_TRANSCRIPT_ENTRIES))
  } else {
    ctx.transcriptCache.set(conversationId, existing)
  }
}

function resetConversationMetadataAndStats(
  conv: NonNullable<ReturnType<ConversationStoreContext['conversations']['get']>>,
  isInitial: boolean,
): void {
  // Reset metadata + stats on initial load to avoid double-counting when
  // the transcript watcher re-reads the full file (restart, reconnect,
  // truncation recovery). Preserve user-set titles (set via spawn dialog).
  if (isInitial) {
    conv.summary = undefined
    if (!conv.titleUserSet) conv.title = undefined
    conv.agentName = undefined
    conv.prLinks = undefined
  }
  conv.stats = {
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreation: 0,
    totalCacheWrite5m: 0,
    totalCacheWrite1h: 0,
    totalCacheRead: 0,
    turnCount: 0,
    toolCallCount: 0,
    compactionCount: 0,
    linesAdded: 0,
    linesRemoved: 0,
    totalApiDurationMs: 0,
  }
}
