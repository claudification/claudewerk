/**
 * Build the curated `RecapDigest` -- the wire-safe projection of the gather
 * digests that the control panel renders as charts + a per-conversation
 * drill-down. Persisted as digest_json. Kept deliberately small: only what a
 * chart or a list row needs, never raw transcripts.
 */

import type {
  RecapDigest,
  RecapDigestActivity,
  RecapDigestCommits,
  RecapDigestContextBucket,
} from '../../../../shared/protocol'
import type { CommitDigest, ConversationDigest, CostDigest, ErrorDigest, ToolUseDigest } from '../gather/types'

export function buildRecapDigest(args: {
  cost: CostDigest
  conversations: ConversationDigest[]
  commits?: CommitDigest
  /** Pillar E COST 1: tool-use + incident rollups (absent in older callers). */
  tools?: ToolUseDigest
  errors?: ErrorDigest
}): RecapDigest {
  const costByConv = new Map(args.cost.perConversation.map(c => [c.conversationId, c.costUsd]))
  const conversations = args.conversations
    .map(c => ({
      id: c.id,
      title: c.title,
      turns: c.turnCount,
      status: c.status,
      costUsd: costByConv.get(c.id),
      // Timestamped source pointers: every recap's roster links back to the
      // exact conversation + its time window for drill-down into the transcript.
      createdAt: c.createdAt,
      updatedAt: c.updatedAt,
    }))
    // Heaviest conversations first -- the drill-down leads with where the
    // money + work went.
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.turns - a.turns)

  const commits = summarizeCommits(args.commits)
  const activity = buildActivity(args.conversations, args.tools, args.errors)
  const contextBuckets: RecapDigestContextBucket[] = args.cost.contextBuckets.map(b => ({
    bucket: b.bucket,
    lowerTokens: b.lowerTokens,
    conversations: b.conversations,
    costUsd: b.costUsd,
    cacheWriteTokens: b.cacheWriteTokens,
    turns: b.turns,
  }))
  return {
    cost: {
      totalCostUsd: args.cost.totalCostUsd,
      totalTurns: args.cost.totalTurns,
      totalInputTokens: args.cost.totalInputTokens,
      totalOutputTokens: args.cost.totalOutputTokens,
      totalCacheReadTokens: args.cost.totalCacheReadTokens,
      totalCacheWriteTokens: args.cost.totalCacheWriteTokens,
      perDay: args.cost.perDay.map(d => ({
        day: d.day,
        costUsd: d.costUsd,
        inputTokens: d.inputTokens,
        outputTokens: d.outputTokens,
        cacheReadTokens: d.cacheReadTokens,
        // FIX (Pillar E): the old projection dropped cacheWriteTokens, so the
        // re-warm tax was invisible in the per-day series. Carry it through.
        cacheWriteTokens: d.cacheWriteTokens,
        turns: d.turns,
      })),
      perModel: args.cost.perModel.map(m => ({
        model: m.model,
        costUsd: m.costUsd,
        tokens: m.inputTokens + m.outputTokens,
        turns: m.turns,
      })),
    },
    conversations,
    ...(commits ? { commits } : {}),
    activity,
    ...(contextBuckets.length ? { contextBuckets } : {}),
  }
}

/** Classify a CC tool name into the read/edit/write/bash showcase buckets. */
function classifyTool(tool: string): 'read' | 'edit' | 'write' | 'bash' | 'other' {
  switch (tool) {
    case 'Read':
    case 'Glob':
    case 'Grep':
    case 'NotebookRead':
    case 'LS':
      return 'read'
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return 'edit'
    case 'Write':
      return 'write'
    case 'Bash':
      return 'bash'
    default:
      return 'other'
  }
}

function buildActivity(
  conversations: ConversationDigest[],
  tools?: ToolUseDigest,
  errors?: ErrorDigest,
): RecapDigestActivity {
  const toolCalls = { total: 0, read: 0, edit: 0, write: 0, bash: 0, other: 0 }
  for (const conv of tools?.perConversation ?? []) {
    for (const t of conv.perTool) {
      toolCalls.total += t.count
      toolCalls[classifyTool(t.tool)] += t.count
    }
  }
  return {
    conversations: conversations.length,
    turns: conversations.reduce((sum, c) => sum + c.turnCount, 0),
    toolCalls,
    incidents: errors?.incidents.length ?? 0,
  }
}

// fallow-ignore-next-line complexity
function summarizeCommits(c?: CommitDigest): RecapDigestCommits | undefined {
  if (!c) return undefined
  let total = 0
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const p of c.perProject) {
    for (const e of p.commits) {
      total++
      filesChanged += e.filesChanged ?? 0
      insertions += e.insertions ?? 0
      deletions += e.deletions ?? 0
    }
  }
  if (total === 0) return undefined
  return { total, filesChanged, insertions, deletions }
}
