/**
 * Build the curated `RecapDigest` -- the wire-safe projection of the gather
 * digests that the control panel renders as charts + a per-conversation
 * drill-down. Persisted as digest_json. Kept deliberately small: only what a
 * chart or a list row needs, never raw transcripts.
 */

import type { RecapDigest, RecapDigestCommits } from '../../../../shared/protocol'
import type { CommitDigest, ConversationDigest, CostDigest } from '../gather/types'

export function buildRecapDigest(args: {
  cost: CostDigest
  conversations: ConversationDigest[]
  commits?: CommitDigest
}): RecapDigest {
  const costByConv = new Map(args.cost.perConversation.map(c => [c.conversationId, c.costUsd]))
  const conversations = args.conversations
    .map(c => ({
      id: c.id,
      title: c.title,
      turns: c.turnCount,
      status: c.status,
      costUsd: costByConv.get(c.id),
    }))
    // Heaviest conversations first -- the drill-down leads with where the
    // money + work went.
    .sort((a, b) => (b.costUsd ?? 0) - (a.costUsd ?? 0) || b.turns - a.turns)

  const commits = summarizeCommits(args.commits)
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
