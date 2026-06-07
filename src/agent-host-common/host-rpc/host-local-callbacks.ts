/**
 * Host-local MCP callbacks.
 *
 * These touch host-specific machinery -- the PTY/headless stream, the
 * interaction-replay registry, process lifecycle -- so the per-host bits are
 * delegated to `ctx.sinks`. The shared, host-agnostic logic (notify/share-file
 * over the broker, the auto-approve decision, diag) lives here. Lifted from
 * claude-agent-host; behavior-preserving.
 */

import { isPathWithinCwd } from '../../shared/path-guard'
import { wsToHttpUrl } from '../../shared/ws-url'
import { debug } from '../mcp-host/debug'
import type { McpChannelCallbacks } from '../mcp-host/mcp-tools/types'
import { type HostRpcContext, senderId } from './context'

export function buildHostLocalCallbacks(ctx: HostRpcContext): McpChannelCallbacks {
  const { transport, diag, sinks } = ctx

  return {
    onNotify(message, title) {
      diag('channel', `Notify: ${title ? `[${title}] ` : ''}${message.slice(0, 80)}`)
      if (transport.isConnected()) {
        transport.send({ type: 'notify', conversationId: ctx.conversationId, message, title })
      }
    },

    async onShareFile(filePath) {
      if (!isPathWithinCwd(filePath, ctx.cwd)) {
        const msg = `Path ${filePath} is outside the conversation working directory (${ctx.cwd}). share_file only accepts paths within CWD -- copy the file into the project tree first, or run the conversation from a parent directory.`
        debug(`[channel] share_file: ${msg}`)
        return { error: msg }
      }
      const httpUrl = ctx.noBroker ? null : wsToHttpUrl(ctx.brokerUrl)
      if (!httpUrl) return { error: 'No broker connection -- share_file requires a broker to upload to.' }
      try {
        const file = Bun.file(filePath)
        if (!(await file.exists())) {
          const msg = `File not found: ${filePath}`
          debug(`[channel] share_file: ${msg}`)
          return { error: msg }
        }
        const contentType = file.type || 'application/octet-stream'
        const res = await fetch(`${httpUrl}/api/files`, {
          method: 'POST',
          headers: {
            'Content-Type': contentType,
            'X-Conversation-Id': senderId(ctx),
            ...(ctx.brokerSecret ? { Authorization: `Bearer ${ctx.brokerSecret}` } : {}),
          },
          body: file,
        })
        if (!res.ok) {
          const body = await res.text().catch(() => '')
          const msg = `Broker upload failed: HTTP ${res.status}${body ? ` -- ${body.slice(0, 200)}` : ''}`
          debug(`[channel] share_file: ${msg}`)
          return { error: msg }
        }
        const data = (await res.json()) as { url?: string }
        if (!data.url) return { error: 'Broker returned no URL.' }
        diag('channel', `Shared: ${filePath} -> ${data.url}`)
        return { url: data.url }
      } catch (err) {
        const msg = `Upload error: ${err instanceof Error ? err.message : String(err)}`
        debug(`[channel] share_file: ${msg}`)
        return { error: msg }
      }
    },

    onPermissionRequest(data) {
      if (ctx.permissionRules.shouldAutoApprove(data.toolName, data.inputPreview)) {
        sinks.permissionAllow(data.requestId)
        diag(ctx.headless ? 'headless' : 'channel', `Permission auto-approved: ${data.requestId} ${data.toolName}`)
        if (transport.isConnected()) {
          transport.send({
            type: 'permission_auto_approved',
            conversationId: ctx.conversationId,
            requestId: data.requestId,
            toolName: data.toolName,
            description: data.description,
          } as unknown as Parameters<typeof transport.send>[0])
        }
        return
      }
      diag('channel', `Permission request: ${data.requestId} ${data.toolName}`)
      sinks.registerPermissionRequest(data)
    },

    onDialogShow(dialogId, layout) {
      diag('dialog', `Show: "${layout.title}" (${dialogId.slice(0, 8)})`)
      sinks.dialogShow(dialogId, layout)
    },

    onDialogDismiss(dialogId, reason) {
      diag('dialog', `Dismiss: ${dialogId.slice(0, 8)}${reason ? ` (${reason})` : ''}`)
      // Stop replaying dialog_show on reconnect -- the dialog is dead on this
      // host. On 'timeout' the broker keeps the layout re-displayable (expired).
      sinks.dialogDismiss(dialogId, reason)
    },

    onDeliverMessage(content, meta) {
      sinks.deliverMessage(content, meta)
    },

    onDisconnect() {
      diag('channel', 'Channel disconnected')
    },

    onTogglePlanMode() {
      sinks.togglePlanMode()
    },

    onExitConversation(status, message) {
      sinks.exit(status, message)
    },
  }
}
