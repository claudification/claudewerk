/**
 * THE STATS TABLE's third producer: per-conversation token flow.
 *
 * The store card claimed a third producer would be a metric string plus one
 * `recordStat()` call. This is that claim cashed in -- four calls, no schema
 * change, no migration, no new table. The seam in `add-transcript-entries.ts`
 * is one import and one call, and `token-stats.wiring.test.ts` holds it there.
 *
 * A SECOND, COARSER VIEW -- `token_samples` IS NOT TOUCHED. That table keeps its
 * uuid de-dup, its model column, its 5m/1h TTL split and its three indexes, and
 * analytics keeps reading it exactly as before. What lands here is the same four
 * numbers hung off the shared `(nodeId, kind, name)` vocabulary, so a token
 * series can be read next to a CPU series by one query instead of two schemas.
 *
 * THE OBJECT IS THE CONVERSATION, THE NODE IS ITS SENTINEL. `name` is the
 * conversation id because it is stable across a `/rename`; the title is a label
 * and goes in `label`, so renaming a conversation updates the row instead of
 * forking the series -- the same node/hostname split the store card made.
 *
 * FLOW, NOT GAUGE. Each value is what ONE assistant message billed, never a
 * running total. Zeroes are filed rather than skipped: a message that read
 * nothing from cache really did read zero, and dropping the point would leave a
 * gap that reads as "no message here".
 */

import type { Conversation } from '../../../shared/protocol'
import type { PerMessageTokenSample } from '../../../shared/token-usage'
import { recordStat } from '../../stats/store'

/**
 * File one assistant message's four token counts against its conversation.
 *
 * Called only for a sample the token store accepted as NEW, so a full-file
 * transcript re-read costs nothing here. `stat_samples` is `INSERT OR IGNORE`
 * on `(object, metric, ts)` as a second line of defence, so a replay that did
 * reach this far still cannot double-count.
 *
 * NO SENTINEL, NO SAMPLE. `nodeId` is identity in this store; falling back to
 * `''` would collapse every unhosted conversation onto one fictional node and
 * quietly merge their series. Every live row in `token_samples` carries a
 * sentinel id, so this drops nothing in practice -- it just refuses to invent
 * one. Same reasoning as `plan-usage-series`, which skips a profile with no node.
 */
export function recordConversationTokenStats(
  conversationId: string,
  conv: Conversation,
  timestamp: number,
  sample: PerMessageTokenSample,
): void {
  const nodeId = conv.hostSentinelId
  if (!nodeId) return
  const ref = {
    nodeId,
    kind: 'conversation' as const,
    name: conversationId,
    ...(conv.title ? { label: conv.title } : {}),
  }
  recordStat(ref, 'tokens_in_count', sample.inputTokens, timestamp)
  recordStat(ref, 'tokens_out_count', sample.outputTokens, timestamp)
  recordStat(ref, 'cache_read_count', sample.cacheReadTokens, timestamp)
  recordStat(ref, 'cache_write_count', sample.cacheWriteTokens, timestamp)
}
