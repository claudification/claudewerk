/**
 * THE DIALOGUE — persistent-dialog show path (split out of the `dialog` tool).
 *
 * A persistent dialog lives across turns: the host owns its authoritative
 * snapshot (in `ctx.openDialogs`), there is no hard timeout (persistent => no
 * timeout) and no `pendingDialogs` entry — it is patched via `update_dialog` and
 * closed via `close_dialog` rather than resolved once. Not advertised in the
 * `dialog` tool description yet (renderer lands in D2); a no-op-safe groundwork
 * path, accepted only when the caller passes `persistent: true`.
 */

import type { DialogLayout } from '../../../shared/dialog-schema'
import type { McpToolContext, ToolResult } from './types'

export function showPersistentDialog(ctx: McpToolContext, dialogId: string, layout: DialogLayout): ToolResult {
  ctx.openDialogs.register(dialogId, layout)
  ctx.elog(` persistent "${layout.title}" (${dialogId.slice(0, 8)}) registered`)
  ctx.callbacks.onDialogShow?.(dialogId, layout)
  return {
    content: [
      {
        type: 'text',
        text: `Live dialog "${layout.title}" shown. It persists across turns -- patch it with update_dialog(dialogId, ops), close it with close_dialog(dialogId), reopen with reopen_dialog(dialogId). Dialog ID: ${dialogId}. IMPORTANT: when the work this dialog covers is finished (you've delivered the plan/recap/answer and there is nothing left to iterate on), you MUST close it with close_dialog("${dialogId}") -- a live dialog left open keeps demanding the user's attention. Do not leave it open at the end of the task.`,
      },
    ],
  }
}
