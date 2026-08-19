/**
 * Clipboard capture relay: agent host -> control panel.
 *
 * PTY sessions capture OSC 52 writes; this forwards them to subscribed
 * dashboards, project-scoped. Split out of `permissions.ts`, where it had no
 * business living.
 */

import type { MessageHandler } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { conversationForBroadcast } from './relay-helpers'

const clipboardCapture: MessageHandler = (ctx, data) => {
  const target = conversationForBroadcast(ctx, data, 'clipboard', 'capture')
  if (!target) return
  const { conversationId, conversation } = target
  ctx.broadcastScoped(
    {
      type: 'clipboard_capture',
      conversationId,
      contentType: data.contentType,
      text: data.text,
      base64: data.base64,
      mimeType: data.mimeType,
      timestamp: data.timestamp || Date.now(),
    },
    conversation.project,
  )
  ctx.log.debug(`[clipboard] ${data.contentType}${data.mimeType ? ` (${data.mimeType})` : ''}`)
}

export function registerClipboardHandlers(): void {
  registerHandlers({ clipboard_capture: clipboardCapture }, AGENT_HOST_ONLY)
}
