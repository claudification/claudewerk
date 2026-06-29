/**
 * THE DIALOGUE — live-dialog control tools (update / close / reopen).
 *
 * These operate on a persistent dialog's host-authoritative snapshot
 * (`ctx.openDialogs`). Visible to the agent as of D2 (the persistent renderer
 * now reflects every patch); D1b shipped them hidden until the UI existed.
 */

import type { DialogOp, DialogSnapshot } from '../../../shared/dialog-live'
import type { OpConflict } from '../../../shared/dialog-ops'
import { validateDialogOps } from '../../../shared/dialog-ops'
import type { McpToolContext, ToolDef, ToolResult } from './types'

const opsItemSchema = { type: 'object' as const }

function err(text: string): ToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

function ok(text: string): ToolResult {
  return { content: [{ type: 'text', text }] }
}

/** Render a not-applicable lifecycle result into an agent-facing error. */
function lifecycleError(verb: string, dialogId: string, reason: string): ToolResult {
  return err(`Cannot ${verb} dialog ${dialogId}: ${reason}.`)
}

/** Build the success message for a patch, including any unapplied conflicts. */
function patchSummary(dialogId: string, snapshot: DialogSnapshot, conflicts: OpConflict[]): string {
  const lines = [
    `Dialog ${dialogId} patched. New seq=${snapshot.seq}.`,
    `Current state: ${JSON.stringify(snapshot.state)}`,
    `Reminder: keep this dialog SMALL. As topics resolve, removePage the tabs that no longer matter and remove blocks by id. Only the live, still-actionable part should remain. The instant it is RESOLVED, CLOSE with close_dialog("${dialogId}"). After patching blocks on a tab, include setPage to focus it.`,
  ]
  if (conflicts.length > 0) {
    lines.push('Conflicts (NOT applied):')
    for (const c of conflicts) lines.push(`  - op[${c.index}] ${c.op.op}: ${c.reason}`)
  }
  return lines.join('\n')
}

function registerUpdate(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Patch a live (persistent) dialog in place. Pass the dialogId and an ordered list of ops. Block ops: replace/append/remove (by stable block id). Value ops: setState/unsetState. Tab ops: setPage (focus a tab by index or label), addPage (label, body, after?), removePage (page index or label), replacePage (page, label?, body?). Lifecycle: busy (wait hint), close. Optional baseSeq guards against stale snapshots. Keep the dialog SMALL: as a topic resolves, removePage the tabs the user no longer needs -- only the live, actionable tabs should show. After patching blocks on a tab, ALWAYS include a setPage op to focus the changed tab so the user sees the update. To restart from scratch: close_dialog and open a fresh dialog. When the whole thing is RESOLVED, close it with close_dialog.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dialogId: { type: 'string', description: 'The live dialog to patch.' },
        ops: { type: 'array', description: 'Ordered DialogOp list.', items: opsItemSchema },
        baseSeq: { type: 'number', description: 'The seq the ops were authored against (ordering guard).' },
        rationale: { type: 'string', description: 'Optional human-facing reason for the change.' },
      },
      required: ['dialogId', 'ops'],
    },
    async handle(_params, toolCtx) {
      const args = (toolCtx.rawArgs ?? {}) as { dialogId?: string; ops?: unknown; baseSeq?: number; rationale?: string }
      if (typeof args.dialogId !== 'string' || args.dialogId === '') return err('dialogId is required')
      const opErrors = validateDialogOps(args.ops)
      if (opErrors.length > 0) return err(`Invalid ops:\n${opErrors.join('\n')}`)

      const ops = args.ops as DialogOp[]
      const result = ctx.openDialogs.applyOps(args.dialogId, ops, args.baseSeq)
      if (!result.ok) {
        const seqNote = result.currentSeq !== undefined ? ` (currentSeq=${result.currentSeq})` : ''
        return err(`Cannot update dialog ${args.dialogId}: ${result.reason}${seqNote}.`)
      }

      const { snapshot, conflicts } = result
      ctx.callbacks.onDialogPatch?.(args.dialogId, snapshot.seq - 1, ops, snapshot, args.rationale)
      ctx.elog(` update_dialog ${args.dialogId.slice(0, 8)} -> seq=${snapshot.seq} (${conflicts.length} conflict(s))`)
      return ok(patchSummary(args.dialogId, snapshot, conflicts))
    },
  }
}

function registerClose(ctx: McpToolContext): ToolDef {
  return {
    description:
      'Close a live (persistent) dialog. It becomes terminal but reopenable; its final state is kept as a record.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        dialogId: { type: 'string', description: 'The live dialog to close.' },
        reason: { type: 'string', description: 'Optional human-facing reason.' },
      },
      required: ['dialogId'],
    },
    async handle(_params, toolCtx) {
      const args = (toolCtx.rawArgs ?? {}) as { dialogId?: string; reason?: string }
      if (typeof args.dialogId !== 'string' || args.dialogId === '') return err('dialogId is required')
      const result = ctx.openDialogs.close(args.dialogId)
      if (!result.ok) return lifecycleError('close', args.dialogId, result.reason)

      const { snapshot } = result
      ctx.callbacks.onDialogPatch?.(args.dialogId, snapshot.seq - 1, [{ op: 'close' }], snapshot, args.reason)
      ctx.elog(` close_dialog ${args.dialogId.slice(0, 8)} -> seq=${snapshot.seq}`)
      return ok(`Dialog ${args.dialogId} closed (reopenable). seq=${snapshot.seq}.`)
    },
  }
}

function registerReopen(ctx: McpToolContext): ToolDef {
  return {
    description: 'Reopen a previously-closed live (persistent) dialog into its persisted state.',
    inputSchema: {
      type: 'object' as const,
      properties: { dialogId: { type: 'string', description: 'The closed dialog to reopen.' } },
      required: ['dialogId'],
    },
    async handle(_params, toolCtx) {
      const args = (toolCtx.rawArgs ?? {}) as { dialogId?: string }
      if (typeof args.dialogId !== 'string' || args.dialogId === '') return err('dialogId is required')
      const result = ctx.openDialogs.reopen(args.dialogId)
      if (!result.ok) return lifecycleError('reopen', args.dialogId, result.reason)

      const { snapshot } = result
      ctx.callbacks.onDialogReopen?.(args.dialogId, snapshot)
      ctx.elog(` reopen_dialog ${args.dialogId.slice(0, 8)} -> seq=${snapshot.seq}`)
      return ok(`Dialog ${args.dialogId} reopened. seq=${snapshot.seq}.`)
    },
  }
}

export function registerDialogControlTools(ctx: McpToolContext): Record<string, ToolDef> {
  return {
    update_dialog: registerUpdate(ctx),
    close_dialog: registerClose(ctx),
    reopen_dialog: registerReopen(ctx),
  }
}
