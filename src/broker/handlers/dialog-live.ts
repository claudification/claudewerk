/**
 * THE DIALOGUE (D1c) — host -> broker -> panel live-dialog handlers.
 *
 * The HOST owns the authoritative snapshot; the broker persists it OPAQUELY
 * (single per-conversation slot), broadcasts it to authorized panels, and
 * replays it on reconnect (see handlers/channel.ts). It never interprets
 * layout/state/ops — only `.status` for lifecycle. The inbound dialog_event
 * (panel -> broker -> host) lives in handlers/dialog-event.ts.
 *
 * Covenants: EVERYTHING IS A STRUCTURED MESSAGE (dialog_orphaned is typed end
 * to end), LOG EVERYTHING (every transition logs ids + prev->next status + seq),
 * BOUNDARY (no ccSessionId; snapshot opaque).
 */

import type { DialogSnapshot } from '../../shared/dialog-live'
import type { DialogLayout } from '../../shared/dialog-schema'
import { cancelDialogNotify, scheduleDialogNotify } from '../attention-notify'
import { initialLiveSlot, jsonBytes, mergeLiveSlot, withinSnapshotCap } from '../dialog-live-store'
import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, DASHBOARD_ROLES, registerHandlers } from '../message-router'
import { dialogEvent, dialogLiveDismiss } from './dialog-event'

type Ctx = Parameters<MessageHandler>[0]

/**
 * Persistent (live) dialog show: store the synthesized initial snapshot in the
 * single live slot + an attention indicator, then broadcast the show to panels.
 * Called from the one-shot dialog_show handler when `layout.persistent` is set,
 * keeping that baselined handler thin.
 */
export function showPersistentDialog(
  ctx: Ctx,
  conversationId: string,
  dialogId: string,
  layout: Record<string, unknown>,
): void {
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return
  conv.liveDialog = initialLiveSlot(dialogId, layout as unknown as DialogLayout, Date.now())
  conv.pendingAttention = { type: 'dialog', question: (layout.title as string) || 'Dialog', timestamp: Date.now() }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)

  if (!conv.project) {
    ctx.log.debug(`[dialog-live] dropping show: no project on ${conversationId.slice(0, 8)}`)
    return
  }
  ctx.broadcastScoped({ type: 'dialog_show', conversationId, dialogId, layout }, conv.project)
  scheduleDialogNotify({ conversationId, project: conv.project, dialogTitle: (layout.title as string) || 'Dialog' })
  ctx.log.info(
    `[dialog-live] show persistent "${layout.title}" (${dialogId.slice(0, 8)}) conv=${conversationId.slice(0, 8)} seq=0 status=open`,
  )
}

/**
 * Persist a host snapshot into the conversation's single live slot. Returns the
 * previous status (for logging) or null when the conversation is gone / the
 * snapshot is over the byte cap (rejected, not persisted).
 */
function persistHostSnapshot(ctx: Ctx, conversationId: string, snapshot: DialogSnapshot): string | null {
  const conv = ctx.conversations.getConversation(conversationId)
  if (!conv) return null
  if (!withinSnapshotCap(snapshot)) {
    ctx.log.error(
      `[dialog-live] REJECTED oversize snapshot dialog=${snapshot.dialogId.slice(0, 8)} conv=${conversationId.slice(0, 8)} bytes=${jsonBytes(snapshot)} cap-exceeded`,
    )
    return null
  }
  const prevStatus = conv.liveDialog?.snapshot.status ?? 'none'
  conv.liveDialog = mergeLiveSlot(conv.liveDialog, snapshot, Date.now())
  if (snapshot.status !== 'open' && conv.pendingAttention?.type === 'dialog') {
    delete conv.pendingAttention
  }
  ctx.conversations.persistConversationById(conversationId)
  ctx.conversations.broadcastConversationUpdate(conversationId)
  return prevStatus
}

// Shared head for the three host->panel handlers: parse ids + snapshot, persist
// opaquely, resolve the conversation. Returns null on bad input / rejected
// (over byte cap) so each handler stays a thin per-type relay (no duplicated
// validate+persist preamble, no per-handler branching pile-up).
interface AcceptedSnapshot {
  conversationId: string
  dialogId: string
  snapshot: DialogSnapshot
  conv: ReturnType<Ctx['conversations']['getConversation']>
  prevStatus: string
}
function acceptHostSnapshot(ctx: Ctx, data: Parameters<MessageHandler>[1]): AcceptedSnapshot | null {
  const conversationId = (data.conversationId || ctx.ws.data.conversationId) as string
  const dialogId = data.dialogId as string
  const snapshot = data.snapshot as DialogSnapshot | undefined
  if (!conversationId || !dialogId || !snapshot) return null
  const prevStatus = persistHostSnapshot(ctx, conversationId, snapshot)
  if (prevStatus === null) return null
  return { conversationId, dialogId, snapshot, conv: ctx.conversations.getConversation(conversationId), prevStatus }
}

// Agent patched a live dialog -> persist + relay to panels for reconciliation.
const dialogPatch: MessageHandler = (ctx, data) => {
  const a = acceptHostSnapshot(ctx, data)
  if (!a) return
  if (a.conv?.project) {
    ctx.broadcastScoped(
      {
        type: 'dialog_patch',
        conversationId: a.conversationId,
        dialogId: a.dialogId,
        baseSeq: data.baseSeq,
        ops: data.ops,
        snapshot: a.snapshot,
        ...(typeof data.rationale === 'string' ? { rationale: data.rationale } : {}),
      },
      a.conv.project,
    )
  }
  if (a.snapshot.status !== 'open') cancelDialogNotify(a.conversationId, `snapshot-${a.snapshot.status}`)
  ctx.log.info(
    `[dialog-live] patch dialog=${a.dialogId.slice(0, 8)} conv=${a.conversationId.slice(0, 8)} status=${a.prevStatus}->${a.snapshot.status} seq=${a.snapshot.seq} ops=${Array.isArray(data.ops) ? data.ops.length : 0}`,
  )
}

// Agent reopened a closed dialog into its persisted live state.
const dialogReopen: MessageHandler = (ctx, data) => {
  const a = acceptHostSnapshot(ctx, data)
  if (!a) return
  if (a.conv?.project) {
    ctx.broadcastScoped(
      { type: 'dialog_reopen', conversationId: a.conversationId, dialogId: a.dialogId, snapshot: a.snapshot },
      a.conv.project,
    )
  }
  ctx.log.info(
    `[dialog-live] reopen dialog=${a.dialogId.slice(0, 8)} conv=${a.conversationId.slice(0, 8)} status=${a.prevStatus}->${a.snapshot.status} seq=${a.snapshot.seq}`,
  )
}

// Agent gone (/clear, conversation end) -> dialog becomes a read-only record.
const dialogOrphaned: MessageHandler = (ctx, data) => {
  const a = acceptHostSnapshot(ctx, data)
  if (!a) return
  const reason = (data.reason as string) || 'orphaned'
  cancelDialogNotify(a.conversationId, `orphaned:${reason}`)
  if (a.conv?.project) {
    ctx.broadcastScoped(
      { type: 'dialog_orphaned', conversationId: a.conversationId, dialogId: a.dialogId, reason, snapshot: a.snapshot },
      a.conv.project,
    )
  }
  ctx.log.info(
    `[dialog-live] orphaned dialog=${a.dialogId.slice(0, 8)} conv=${a.conversationId.slice(0, 8)} status=${a.prevStatus}->orphaned seq=${a.snapshot.seq} reason=${reason}`,
  )
}

export function registerDialogLiveHandlers(): void {
  registerHandlers(
    { dialog_patch: dialogPatch, dialog_reopen: dialogReopen, dialog_orphaned: dialogOrphaned },
    AGENT_HOST_ONLY,
  )
  registerHandlers({ dialog_event: dialogEvent, dialog_live_dismiss: dialogLiveDismiss }, DASHBOARD_ROLES)
}
