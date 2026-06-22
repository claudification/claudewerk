/**
 * The ASYNC IMPULSE -- a dispatched worker's report-back wakes the dispatcher
 * (plan §3 B3). The reserved `dispatcher` send_message sink calls this.
 *
 * The flow embodies the core mandate: an async result arriving is a BLOCK
 * MUTATION (`<pending qN>` -> `<findings qN>`), and that mutation IS the impulse.
 * We mutate the user's living history, run one dispatcher turn over it (the loop
 * reads the fresh `<findings>` and continues the conversation), broadcast the
 * reply to that user's overlay, then drop the delivered findings block.
 *
 * No new machinery: it composes getUserHistory (B2) + runDispatchAgent (B2) +
 * broadcastToSubscribers (existing) + the quest registry (B3).
 */

import type { DispatchDecision } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { broadcastToSubscribers } from '../routes/shared'
import { runDispatchAgent } from './agent-runtime'
import { getUserHistory } from './history-store'
import { dropBlock, upsertBlock } from './living-history'
import { clearQuest, resolveQuest } from './quest-registry'
import type { DispatchRuntime } from './runtime'

export interface DeliverResult {
  ok: boolean
  detail: string
}

/** Injectable seams (test). Default to the live impulse loop + WS broadcast. */
export interface DeliverDeps {
  runImpulse?: (intent: string, rt: DispatchRuntime, opts: { userId: string | null }) => Promise<DispatchDecision>
  broadcast?: (store: ConversationStore, message: Record<string, unknown>) => void
}

/**
 * Deliver a worker's report-back to the user's dispatcher.
 *  - Resolve which user + which pending block via the quest registry.
 *  - Upsert the `<findings id=..>` block (resolves the matching `<pending>`).
 *  - Run ONE dispatcher impulse so it relays the result to the user.
 *  - Broadcast the reply to that user's overlay, then drop the findings block.
 */
export async function deliverDispatcherReport(
  store: ConversationStore,
  callerConversationId: string | null | undefined,
  message: string,
  deps: DeliverDeps = {},
): Promise<DeliverResult> {
  const runImpulse = deps.runImpulse ?? runDispatchAgent
  const broadcast = deps.broadcast ?? broadcastToSubscribers
  const link = resolveQuest(callerConversationId)
  if (!link) {
    return { ok: false, detail: 'no dispatcher quest is registered for this caller' }
  }

  const now = Date.now()
  const history = getUserHistory(link.userId)
  // THE MUTATION = THE IMPULSE: <pending qN> becomes <findings qN> in place.
  upsertBlock(history, link.pendingId, 'findings', message, now)

  // The dispatcher acts on the USER's behalf here, not as a child of the worker,
  // so the impulse runs with no caller lineage (a fresh spawn would be the user's).
  const rt: DispatchRuntime = { store, callerConversationId: null }
  const trigger =
    `A worker you dispatched for "${link.intent}" has reported back -- read <findings id="${link.pendingId}"> ` +
    'and relay the result to the user now, as a natural continuation. Then this thread is done.'

  let detail: string
  try {
    const decision = await runImpulse(trigger, rt, { userId: link.userId })
    // Unsolicited async reply -> broadcast to the user's overlay (userId-stamped).
    broadcast(store, { ...decision, userId: link.userId })
    detail = `relayed to ${link.userId ?? 'anon'} (${decision.reply ? 'reply sent' : 'no reply'})`
  } finally {
    // The findings have been relayed (or the turn failed) -- drop the block either
    // way so the context never accumulates stale findings, and retire the quest.
    dropBlock(history, link.pendingId)
    if (callerConversationId) clearQuest(callerConversationId)
  }
  return { ok: true, detail }
}
