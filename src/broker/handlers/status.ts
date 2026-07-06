/**
 * THE STATUS — host -> broker -> dashboard agent self-reported status.
 *
 * The host owns the status; the broker stores it in the single per-conversation
 * `liveStatus` slot, broadcasts it to authorized panels, and (for `needs_you`)
 * fires a debounced device push. A new status REPLACES the slot; full history
 * lives in the transcript. RESET to `working` on every user turn lives in the
 * conversation-store (UserPromptSubmit), not here.
 *
 * needs_you push is DERIVED-GATED (Option B): the buzz fires only when the
 * self-reported `needs_you` is corroborated by a real `pendingAttention`
 * (dialog/permission/ask/plan/spawn) — un-fakeable. Debounced per conversation
 * via the shared attention debouncer so it never double-buzzes with the
 * dialog/ask idle timers.
 */

import type { Conversation, LiveStatus } from '../../shared/protocol'
import { notifyNeedsYou, rearmAttentionNotify } from '../attention-notify'
import { emitDeskEvent } from '../desk/event-registry'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { armParentNotify } from '../parent-notify'
import { recordContribution } from '../sotu/contribute'
import { projectSlug } from '../sotu/paths'
import type { StatusContrib } from '../sotu/types'

/** True when this status is older-or-equal than the stored one (host stamps a
 *  monotonic seq), so it must be dropped. */
function isStale(prev: LiveStatus | undefined, status: LiveStatus): boolean {
  return prev !== undefined && typeof status.seq === 'number' && status.seq <= prev.seq
}

/**
 * needs_you escalation: buzz the user's phone ONLY when the self-reported
 * needs_you is corroborated by a real pending interaction (Option B). Any other
 * state re-arms the debouncer so the next genuine needs_you fires immediately.
 */
function handleNeedsYouSignal(conv: Conversation, conversationId: string, status: LiveStatus): void {
  if (status.state !== 'needs_you') {
    rearmAttentionNotify(conversationId)
    return
  }
  if (conv.pendingAttention && conv.project) {
    notifyNeedsYou({
      conversationId,
      project: conv.project,
      summary: status.pending || status.blocked || 'Needs your input',
    })
  }
}

/** Feed the SotU contribution queue so the chronicle sees every status change.
 *  Weight=3 (declared intent, same as callouts). */
function emitSotuContribution(conv: Conversation, conversationId: string, status: LiveStatus): void {
  if (!conv.project) return
  const contrib: StatusContrib = {
    kind: 'status',
    convId: conversationId,
    ts: status.updatedAt ?? Date.now(),
    state: status.state,
  }
  if (status.done) contrib.done = status.done
  if (status.pending) contrib.pending = status.pending
  if (status.blocked) contrib.blocked = status.blocked
  if (status.caveats) contrib.caveats = status.caveats
  if (status.notes) contrib.notes = status.notes
  if (status.safe_to_close) contrib.safe_to_close = true
  recordContribution(projectSlug(conv.project), contrib, conv.project)
}

// Parse + validate + staleness in one place so the handler body stays a thin
// persist/broadcast/notify relay (mirrors dialog-live's acceptHostSnapshot).
type Ctx = Parameters<MessageHandler>[0]
function acceptStatus(
  ctx: Ctx,
  data: Parameters<MessageHandler>[1],
): { conversationId: string; conv: Conversation; status: LiveStatus } | null {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const status = data.status as LiveStatus | undefined
  if (!conversationId || !status || typeof status.state !== 'string') return null
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return null
  if (isStale(conv.liveStatus, status)) {
    ctx.log.debug(`[status] drop stale conv=${conversationId.slice(0, 8)} seq=${status.seq}`)
    return null
  }
  return { conversationId, conv, status }
}

const agentStatus: MessageHandler = (ctx, data) => {
  const a = acceptStatus(ctx, data)
  if (!a) return
  const { conversationId, conv, status } = a
  const prevState = conv.liveStatus?.state ?? 'none'

  conv.liveStatus = status
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
  if (conv.project) {
    ctx.broadcastScoped({ type: 'agent_status', conversationId, status }, conv.project)
  }
  // Background live-status signal into the dispatcher's memory engine (P2). Only
  // on a real state CHANGE -- seq bumps with the same state are noise.
  if (status.state !== prevState) {
    emitDeskEvent({
      kind: 'live_status',
      conversationId,
      project: conv.project ?? null,
      ts: status.updatedAt ?? Date.now(),
      state: status.state,
    })
  }
  handleNeedsYouSignal(conv, conversationId, status)
  emitSotuContribution(conv, conversationId, status)
  // EXPENSIVE report-back: a set_status (re)arms the parent-notify settle timer.
  // No-op unless the child opted in via `notifyParent` at spawn. Re-validated at
  // fire time, so arming mid-turn is safe (a still-active turn just skips).
  armParentNotify(conversationId)

  ctx.log.info(`[status] conv=${conversationId.slice(0, 8)} state=${prevState}->${status.state} seq=${status.seq}`)
}

export function registerStatusHandlers(): void {
  registerHandlers({ agent_status: agentStatus }, AGENT_HOST_ONLY)
}
