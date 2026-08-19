/**
 * THE DIALOGUE (D1c) — inbound dialog_event handler (panel -> broker -> host).
 *
 * A user interaction on a live/persistent dialog. The broker AUTHORIZES it
 * (dialog:interact, single-interactor lock, open-only, byte cap), RATE-LIMITS
 * per principal, stamps a monotonic event seq, then FORWARDS it to the host
 * socket. The host turn DELIVERY (turning the event into an agent turn) + the
 * renderer that emits this land in D2 — until then the host falls through its
 * ws-client default and harmlessly drops it. The security is real + tested now.
 */

import type { Conversation } from '../../shared/protocol'
import { cancelDialogNotify } from '../attention-notify'
import { dialogPrincipal, guardDialogEvent, hasDialogInteract } from '../dialog-interact-guard'
import { type LiveDialogSlot, withinEventStateCap } from '../dialog-live-store'
import { DIALOG_EVENT_RATE, SlidingWindowRateLimiter } from '../dialog-rate-limit'
import { recordDialogTurn } from '../dialog-telemetry'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'

const EVENT_KINDS = new Set(['click', 'change', 'submit', 'close'])
const eventLimiter = new SlidingWindowRateLimiter(DIALOG_EVENT_RATE)

/** Test-only: reset the per-principal rate-limit window. */
export function resetDialogEventLimiter(): void {
  eventLimiter.reset()
}

function echo(data: MessageData): { requestId?: string } {
  return typeof data.requestId === 'string' ? { requestId: data.requestId } : {}
}

interface ForwardEvent {
  conversationId: string
  dialogId: string
  on: string
  seq: number
  principal: string
}

/** Forward an authorized event to the host, count earned turns, then ack the panel. */
function forwardEvent(ctx: HandlerContext, data: MessageData, ev: ForwardEvent): void {
  const { conversationId, dialogId, on, seq } = ev
  const targetWs = ctx.conversations.getConversationSocket(conversationId)
  if (targetWs) {
    targetWs.send(
      JSON.stringify({
        type: 'dialog_event',
        conversationId,
        dialogId,
        seq,
        handlerId: data.handlerId,
        on,
        value: data.value,
        state: withinEventStateCap(data.state) ? (data.state ?? {}) : {},
      }),
    )
  }

  // A `submit` is one earned agent round-trip — count it for overuse telemetry.
  if (on === 'submit') recordDialogTurn(conversationId, dialogId, Date.now(), ctx.log)

  ctx.reply({ type: 'dialog_event_result', ok: true, conversationId, dialogId, seq, ...echo(data) })
  ctx.log.info(
    `[dialog-live] event dialog=${dialogId.slice(0, 8)} conv=${conversationId.slice(0, 8)} on=${on} handler=${String(data.handlerId)} seq=${seq} principal=${ev.principal} forwarded=${!!targetWs}`,
  )
}

export const dialogEvent: MessageHandler = (ctx, data) => {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return

  const reject = (reason: string): void => {
    ctx.reply({ type: 'dialog_event_result', ok: false, conversationId, dialogId, error: reason, ...echo(data) })
    ctx.log.info(
      `[dialog-live] event REJECTED (${reason}) dialog=${dialogId.slice(0, 8)} conv=${conversationId.slice(0, 8)} principal=${ctx.ws.data.userName ?? ctx.ws.data.shareToken?.slice(0, 8) ?? 'bearer'}`,
    )
  }

  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return reject('no_conversation')

  const on = data.on as string
  if (!EVENT_KINDS.has(on)) return reject('bad_event')

  const guard = guardDialogEvent({
    data: ctx.ws.data,
    project: conv.project ?? '*',
    liveDialog: conv.liveDialog,
    dialogId,
    handlerId: data.handlerId,
    state: data.state,
  })
  if (!guard.ok) return reject(guard.reason)

  if (!eventLimiter.check(`${conversationId}:${guard.principal}`)) return reject('rate_limited')

  // Claim the single-interactor lock first-wins, then stamp a monotonic seq.
  const slot = conv.liveDialog
  if (!slot) return reject('no_dialog')
  if (!slot.interactor) slot.interactor = guard.principal
  const seq = (slot.lastEventSeq ?? 0) + 1
  slot.lastEventSeq = seq
  ctx.conversations.persistConversationById(conversationId)

  // Forward to the host (routing only; host turn delivery is D2) + ack the panel.
  forwardEvent(ctx, data, { conversationId, dialogId, on, seq, principal: guard.principal })
}

/** Parse + authorize a dismiss, then locate the matching live slot. Returns null
 *  (bad input / no conversation / no permission / wrong-or-missing slot) so the
 *  handler stays a thin mutate-and-broadcast. Split out to keep both small. */
function resolveDismiss(
  ctx: HandlerContext,
  data: MessageData,
): { conv: Conversation; slot: LiveDialogSlot; dialogId: string; principal: string } | null {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const dialogId = data.dialogId as string
  if (!conversationId || !dialogId) return null
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return null
  const principal = dialogPrincipal(ctx.ws.data)
  if (!hasDialogInteract(ctx.ws.data, conv.project ?? '*')) {
    ctx.log.info(
      `[dialog-live] dismiss DENIED (permission) dialog=${dialogId.slice(0, 8)} conv=${conversationId.slice(0, 8)} principal=${principal}`,
    )
    return null
  }
  const slot = conv.liveDialog
  // Idempotent: already gone, or a newer dialog replaced the slot -> no-op.
  if (!slot || slot.dialogId !== dialogId) return null
  return { conv, slot, dialogId, principal }
}

/** Panel -> broker: AUTHORITATIVE dismiss. Minimize is a per-viewer client pref;
 *  a dismiss DROPS the broker's single live slot so it never replays again, for
 *  any viewer. The agent can re-engage later by patching/reopening (recreates it). */
export const dialogLiveDismiss: MessageHandler = (ctx, data) => {
  const r = resolveDismiss(ctx, data)
  if (!r) return
  const { conv, slot, dialogId, principal } = r
  const prevStatus = slot.snapshot.status
  delete conv.liveDialog
  if (conv.pendingAttention?.type === 'dialog') delete conv.pendingAttention
  cancelDialogNotify(conv.id, 'live-dismissed')
  ctx.conversations.persistConversationById(conv.id)
  ctx.conversations.broadcastConversationUpdate(conv.id)
  if (conv.project) {
    ctx.broadcastScoped({ type: 'dialog_live_dismissed', conversationId: conv.id, dialogId }, conv.project)
  }
  ctx.log.info(
    `[dialog-live] dismissed dialog=${dialogId.slice(0, 8)} conv=${conv.id.slice(0, 8)} status=${prevStatus}->dropped principal=${principal}`,
  )
}
