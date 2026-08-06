/**
 * The ASYNC IMPULSE -- a dispatched worker's report-back wakes the dispatcher
 * (plan §3 B3). The reserved `dispatcher` send_message sink calls this.
 *
 * The flow embodies the core mandate: an async result arriving is a BLOCK
 * MUTATION (`<pending qN>` -> `<findings qN>`), and that mutation IS the impulse.
 * We mutate the user's living history, run one dispatcher turn over it (the loop
 * reads the fresh `<findings>` and continues the conversation), broadcast the
 * reply to that user's overlay -- and SPEAK it to the orb when the quest was
 * dispatched by voice -- then drop the delivered findings block.
 *
 * The answer must come back on the surface it was asked from. The overlay
 * broadcast reaches the dispatch panel and nothing else; a quest dispatched out
 * loud whose findings stop there is an answer the user never receives.
 *
 * No new machinery: it composes getUserHistory (B2) + runDispatchAgent (B2) +
 * broadcastToSubscribers (existing) + the quest registry (B3).
 */

import type { DispatchDecision } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { broadcastToSubscribers } from '../routes/shared'
import { runDispatchAgent } from './agent-runtime'
import { getUserHistory, markDirty } from './history-store'
import { dropBlock, upsertBlock } from './living-history'
import { DISPATCHER_ORB_SOURCE, relayToOrbAs } from './orb-channel'
import { claimQuest } from './quest-registry'
import type { DispatchRuntime } from './runtime'

export interface DeliverResult {
  ok: boolean
  detail: string
}

/** Injectable seams (test). Default to the live impulse loop + WS broadcast. */
export interface DeliverDeps {
  runImpulse?: (
    intent: string,
    rt: DispatchRuntime,
    opts: { userId: string | null; recordUserTurn?: boolean },
  ) => Promise<DispatchDecision>
  broadcast?: (store: ConversationStore, message: Record<string, unknown>) => void
  speak?: (store: ConversationStore, body: string, orbId: string | null) => void
}

/** How much of a relayed reply the orb is handed. A quest can report a wall of
 *  markdown and URLs; past this the realtime model is being fed a document, not
 *  a spoken heads-up. Truncation is REPORTED in the result detail, never silent. */
export const MAX_SPOKEN_REPLY_CHARS = 1200

/** Trim for speech. Returns the body plus what (if anything) was cut. */
function forSpeech(reply: string): { body: string; note: string } {
  if (reply.length <= MAX_SPOKEN_REPLY_CHARS) return { body: reply, note: '' }
  return {
    body: `${reply.slice(0, MAX_SPOKEN_REPLY_CHARS)}...`,
    note: ` truncated ${reply.length}->${MAX_SPOKEN_REPLY_CHARS}`,
  }
}

/**
 * Deliver a worker's report-back to the user's dispatcher.
 *  - Resolve which user + which pending block via the quest registry.
 *  - Upsert the `<findings id=..>` block (resolves the matching `<pending>`).
 *  - Run ONE dispatcher impulse so it relays the result to the user.
 *  - Broadcast the reply to that user's overlay, speak it to the orb if the
 *    quest came from voice, then drop the findings block.
 */
export async function deliverDispatcherReport(
  store: ConversationStore,
  callerConversationId: string | null | undefined,
  message: string,
  deps: DeliverDeps = {},
): Promise<DeliverResult> {
  const runImpulse = deps.runImpulse ?? runDispatchAgent
  const broadcast = deps.broadcast ?? broadcastToSubscribers
  const speak = deps.speak ?? ((s, body, orbId) => void relayToOrbAs(s, DISPATCHER_ORB_SOURCE, body, orbId))
  // Atomically claim the quest: get + delete with no await between, so a second
  // call from the same worker (Haiku double-calling send_message) gets undefined
  // and bails instead of racing through a second impulse + broadcast.
  const link = claimQuest(callerConversationId)
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
    // recordUserTurn:false -- the synthetic trigger is not a user-typed turn; only
    // the dispatcher's relayed reply belongs in the viewable transcript (A0).
    const decision = await runImpulse(trigger, rt, { userId: link.userId, recordUserTurn: false })
    // Unsolicited async reply -> broadcast to the user's overlay (userId-stamped).
    broadcast(store, { ...decision, userId: link.userId })
    detail = `relayed to ${link.userId ?? 'anon'} (${decision.reply ? 'reply sent' : 'no reply'})`
    // ...and OUT LOUD when he asked out loud. The overlay broadcast above reaches
    // the dispatch panel only; an orb-dispatched quest whose answer stops there is
    // an answer he never gets (the 2026-08-06 pillow report).
    if (link.speakToOrb && decision.reply) {
      const { body, note } = forSpeech(decision.reply)
      speak(store, body, link.speakToOrb.orbId)
      detail += `, spoken to orb ${link.speakToOrb.orbId ?? 'all'}${note}`
    }
  } finally {
    // The findings have been relayed (or the turn failed) -- drop the block either
    // way so the context never accumulates stale findings.
    dropBlock(history, link.pendingId)
    markDirty(link.userId) // persist the post-relay state (findings dropped) -- Slice A
  }
  return { ok: true, detail }
}
