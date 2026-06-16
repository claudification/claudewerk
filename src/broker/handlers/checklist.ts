/**
 * Project checklist handlers: dashboard <-> broker.
 *
 * Per-project personal checklists ("notes from me to me") live in the broker's
 * own checklists.db (see checklist-store.ts). The control panel drives every
 * mutation over WS; the broker applies it, replies to the caller, and broadcasts
 * the fresh OPEN list scoped to the project URI so every permitted panel stays
 * in sync (EVERYTHING IS A STRUCTURED MESSAGE).
 *
 * Boundary: never touches ccSessionId. The project URI is the only key; the
 * permission gate (chat:read view, chat mutate) is enforced per call.
 */

import type { ChecklistChanged, ChecklistItem } from '../../shared/protocol'
import {
  createItems,
  deleteItem,
  listArchive,
  listOpen,
  purgeResolved,
  toggleItem,
  updateText,
} from '../checklist-store'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { DASHBOARD_ROLES, registerHandlers } from '../message-router'

/** Push the fresh open list to every panel with chat:read on this project. */
function broadcastOpen(ctx: HandlerContext, project: string): void {
  const msg: ChecklistChanged = { type: 'checklist_changed', project, open: listOpen(project) }
  ctx.broadcastScoped(msg as unknown as Record<string, unknown>, project)
}

function opOk(ctx: HandlerContext, requestId: unknown, extra: Record<string, unknown> = {}): void {
  ctx.reply({ type: 'checklist_op_result', requestId, ok: true, ...extra })
}

// Dashboard -> broker: seed the inline block with the current open items.
const checklistList: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  if (!project) return
  ctx.requirePermission('chat:read', project)
  ctx.reply({ type: 'checklist_list_result', requestId: data.requestId, open: listOpen(project) })
}

// Dashboard -> broker: create N items (multi-line paste / single add).
const checklistCreate: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  const items = data.items as Array<{ text: string; resolved?: boolean }> | undefined
  if (!project || !Array.isArray(items)) return
  ctx.requirePermission('chat', project)
  const inserted = createItems(project, items)
  opOk(ctx, data.requestId, { inserted })
  broadcastOpen(ctx, project)
}

// Dashboard -> broker: resolve / re-open an item.
const checklistToggle: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  const id = data.id as string | undefined
  if (!project || !id) return
  ctx.requirePermission('chat', project)
  toggleItem(project, id, data.resolved === true)
  opOk(ctx, data.requestId)
  broadcastOpen(ctx, project)
}

// Dashboard -> broker: edit an item's (raw) text.
const checklistUpdate: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  const id = data.id as string | undefined
  const text = data.text as string | undefined
  if (!project || !id || typeof text !== 'string') return
  ctx.requirePermission('chat', project)
  updateText(project, id, text)
  opOk(ctx, data.requestId)
  broadcastOpen(ctx, project)
}

// Dashboard -> broker: delete one item outright.
const checklistDelete: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  const id = data.id as string | undefined
  if (!project || !id) return
  ctx.requirePermission('chat', project)
  deleteItem(project, id)
  opOk(ctx, data.requestId)
  broadcastOpen(ctx, project)
}

// Dashboard -> broker: list resolved (archived) items for the completed view.
const checklistArchiveReq: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  if (!project) return
  ctx.requirePermission('chat:read', project)
  const items: ChecklistItem[] = listArchive(project)
  ctx.reply({ type: 'checklist_archive_result', requestId: data.requestId, items })
}

// Dashboard -> broker: bulk-delete resolved items older than N ms.
const checklistPurge: MessageHandler = (ctx, data) => {
  const project = data.project as string | undefined
  const olderThanMs = typeof data.olderThanMs === 'number' ? data.olderThanMs : null
  if (!project || olderThanMs === null) return
  ctx.requirePermission('chat', project)
  const purged = purgeResolved(project, Date.now() - olderThanMs)
  opOk(ctx, data.requestId, { purged })
  // Archive changed; open list is unaffected but cheap to refresh for consistency.
  broadcastOpen(ctx, project)
}

export function registerChecklistHandlers(): void {
  registerHandlers(
    {
      checklist_list: checklistList,
      checklist_create: checklistCreate,
      checklist_toggle: checklistToggle,
      checklist_update: checklistUpdate,
      checklist_delete: checklistDelete,
      checklist_archive: checklistArchiveReq,
      checklist_purge: checklistPurge,
    } satisfies Record<string, MessageHandler>,
    DASHBOARD_ROLES,
  )
}
