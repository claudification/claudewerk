/**
 * TURN SUMMARY -- host -> broker -> dashboard machine-classified conversation state.
 *
 * Answers "what is this conversation doing RIGHT NOW" for the ~everything that
 * never calls `set_status`. The agent host lifts it from CC's own per-turn
 * classifier (`system/post_turn_summary`); the broker stores it in a single
 * per-conversation `turnSummary` slot and broadcasts it to authorized panels.
 * A new summary REPLACES the slot.
 *
 * DELIBERATELY SEPARATE FROM `liveStatus`, in both directions. `liveStatus` is
 * the agent's authored `set_status` claim -- considered, high-trust, the thing a
 * human triages on. This is automatic and cheap. If the two shared a slot, a
 * routine classifier label would overwrite a deliberate `needs_you`, which is
 * precisely the signal a fleet view cannot afford to lose. Consumers prefer
 * `liveStatus` and fall back here.
 *
 * No push notification, ever: this fires every turn on every conversation, so
 * buzzing on it would be a pager that never stops. Attention notification stays
 * the exclusive job of the corroborated `needs_you` path in ./status.
 *
 * Background + the reproducible CC probe: `.claude/docs/plan-conversation-classifier.md`
 */

import type { Conversation, TurnSummary } from '../../shared/protocol'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'

/** Older wall-clock than the stored summary -- drop it. Guards against a
 *  reconnect replaying a summary behind the one already on the slot. */
function isStale(prev: TurnSummary | undefined, next: TurnSummary): boolean {
  return prev !== undefined && typeof next.updatedAt === 'number' && next.updatedAt < prev.updatedAt
}

// Parse + validate + staleness in one place so the handler body stays a thin
// persist/broadcast relay (mirrors ./status's acceptStatus).
type Ctx = Parameters<MessageHandler>[0]
function acceptSummary(
  ctx: Ctx,
  data: Parameters<MessageHandler>[1],
): { conversationId: string; conv: Conversation; summary: TurnSummary } | null {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const summary = data.summary as TurnSummary | undefined
  // A blank detail would blank out a good label -- reject rather than store it.
  if (!conversationId || !summary || typeof summary.detail !== 'string' || !summary.detail) return null
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return null
  if (isStale(conv.turnSummary, summary)) {
    ctx.log.debug(`[turn-summary] drop stale conv=${conversationId.slice(0, 8)} at=${summary.updatedAt}`)
    return null
  }
  return { conversationId, conv, summary }
}

const turnSummary: MessageHandler = (ctx, data) => {
  const a = acceptSummary(ctx, data)
  if (!a) return
  const { conversationId, conv, summary } = a

  const prevDetail = conv.turnSummary?.detail ?? 'none'
  const needsAction = summary.needsAction ? 'yes' : 'no'
  conv.turnSummary = summary
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
  if (conv.project) {
    ctx.broadcastScoped({ type: 'turn_summary', conversationId, summary }, conv.project)
  }

  ctx.log.info(
    `[turn-summary] conv=${conversationId.slice(0, 8)} category=${summary.category} ` +
      `detail="${prevDetail}"->"${summary.detail}" needsAction=${needsAction}`,
  )
}

export function registerTurnSummaryHandlers(): void {
  registerHandlers({ turn_summary: turnSummary }, AGENT_HOST_ONLY)
}
