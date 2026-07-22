/**
 * The canvas chat window's OUTBOUND half: connect a canvas to a conversation,
 * and send the user's typed line (plus their selection) to it.
 *
 * The inbound half -- the agent replying via `send_message` to `canvas:<id>` --
 * lives in desk/canvas-channel.ts. This file is what the browser drives.
 *
 * OWNER-ONLY, deliberately (Jonas, 2026-07-23). Connecting a canvas hands an
 * agent write access to a project's drawing and exposes the project's live
 * conversation list, so it is gated on `files` for the canvas's project -- the
 * same permission that lets you edit the canvas at all. A share-link guest can
 * WATCH the chat (it rides the canvas room they already joined) but can neither
 * connect nor speak, so a read-tier link never becomes a way to drive an agent.
 */

import type { CanvasSelection } from '../../shared/canvas-selection'
import type { InterConversationDelivery } from '../../shared/protocol'
import { getCanvas, setCanvasConnection } from '../canvas-store'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'

const CONNECT_RESULT = 'canvas_chat_connect_result'
const SEND_RESULT = 'canvas_chat_send_result'

/**
 * Load the canvas and require ownership of its project.
 *
 * Returns the canvas, or null after having replied with the refusal. Share
 * guests fail here on `files`: their socket carries a canvas-scoped capability,
 * never project grants.
 */
function requireOwnedCanvas(ctx: HandlerContext, canvasId: unknown, resultType: string) {
  const id = typeof canvasId === 'string' ? canvasId : ''
  if (!id) {
    ctx.reply({ type: resultType, ok: false, error: 'canvasId is required' })
    return null
  }
  const canvas = getCanvas(id)
  if (!canvas) {
    ctx.reply({ type: resultType, ok: false, canvasId: id, error: 'that canvas does not exist' })
    return null
  }
  try {
    ctx.requirePermission('files', canvas.projectUri)
  } catch (e) {
    ctx.reply({ type: resultType, ok: false, canvasId: id, error: (e as Error).message })
    return null
  }
  return canvas
}

type ConnectTarget = { clear: true } | { conversationId: string; title?: string } | { error: string }

/**
 * What the caller is asking for: clear the connection, or wire it to a specific
 * conversation. The target must be real AND in the SAME project as the canvas --
 * the dropdown only offers those, and enforcing it here means a hand-crafted
 * frame cannot point someone's canvas at a conversation in another project.
 */
function resolveConnectTarget(ctx: HandlerContext, projectUri: string, raw: unknown): ConnectTarget {
  if (raw === null || raw === undefined || raw === '') return { clear: true }
  const conversationId = String(raw)
  const target = ctx.conversations.getConversation(conversationId)
  if (!target) return { error: 'that conversation does not exist' }
  if (target.project !== projectUri) {
    return { error: 'a canvas can only connect to a conversation in its own project' }
  }
  return { conversationId, title: target.title }
}

/** Wire (or unwire) a canvas to a conversation. `conversationId: null` clears it. */
const canvasChatConnect: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const canvas = requireOwnedCanvas(ctx, data.canvasId, CONNECT_RESULT)
  if (!canvas) return

  const who = ctx.ws.data.userName ?? 'anon'
  const target = resolveConnectTarget(ctx, canvas.projectUri, data.conversationId)

  if ('error' in target) {
    ctx.reply({ type: CONNECT_RESULT, ok: false, canvasId: canvas.id, error: target.error })
    ctx.log.info(`[canvas-chat] connect REFUSED ${canvas.id.slice(0, 12)} by ${who}: ${target.error}`)
    return
  }
  if ('clear' in target) {
    setCanvasConnection(canvas.id, null)
    ctx.reply({ type: CONNECT_RESULT, ok: true, canvasId: canvas.id, conversationId: null })
    ctx.log.info(`[canvas-chat] ${canvas.id.slice(0, 12)} DISCONNECTED by ${who}`)
    return
  }

  setCanvasConnection(canvas.id, target.conversationId)
  ctx.reply({ type: CONNECT_RESULT, ok: true, canvasId: canvas.id, conversationId: target.conversationId })
  ctx.log.info(
    `[canvas-chat] ${canvas.id.slice(0, 12)} CONNECTED to ${target.conversationId.slice(0, 8)} ` +
      `("${target.title ?? 'untitled'}") by ${who}`,
  )
}

/** Narrow the selection payload off the wire. Malformed = no selection, never a
 *  throw: a bad selection must not cost the user their typed message. */
function readSelection(raw: unknown): CanvasSelection | undefined {
  if (typeof raw !== 'object' || raw === null) return undefined
  const sel = raw as Partial<CanvasSelection>
  if (typeof sel.count !== 'number' || !Array.isArray(sel.elements)) return undefined
  return {
    count: sel.count,
    elements: sel.elements,
    histogram: sel.histogram,
    truncated: sel.truncated === true,
  }
}

/**
 * The user typed into the canvas chat: deliver it to the connected conversation.
 *
 * Carries `sender: 'canvas'` + `source: 'rclaude'` for the same reason the orb
 * does -- this IS the user typing, on a surface they own, so the receiving agent
 * should act on it rather than treat it as an untrusted peer. `fromConversation`
 * is the `canvas:<id>` address, so replying is just answering the sender.
 */
const canvasChatSend: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const canvas = requireOwnedCanvas(ctx, data.canvasId, SEND_RESULT)
  if (!canvas) return

  const message = typeof data.message === 'string' ? data.message.trim() : ''
  if (!message) {
    ctx.reply({ type: SEND_RESULT, ok: false, canvasId: canvas.id, error: 'message is required' })
    return
  }
  const conversationId = canvas.connectedConversationId
  if (!conversationId) {
    ctx.reply({
      type: SEND_RESULT,
      ok: false,
      canvasId: canvas.id,
      error: 'this canvas is not connected to a conversation yet',
    })
    return
  }
  const ws =
    ctx.conversations.findSocketByConversationId(conversationId) ||
    ctx.conversations.getConversationSocket(conversationId)
  if (!ws) {
    ctx.reply({
      type: SEND_RESULT,
      ok: false,
      canvasId: canvas.id,
      error: 'the connected conversation is offline right now',
    })
    return
  }

  const selection = readSelection(data.selection)
  const delivery: InterConversationDelivery = {
    type: 'channel_deliver',
    fromConversation: `canvas:${canvas.id}`,
    fromProject: 'canvas',
    sender: 'canvas',
    source: 'rclaude',
    intent: 'request',
    message,
    canvasId: canvas.id,
    selection,
  }
  ws.send(JSON.stringify(delivery))
  ctx.reply({ type: SEND_RESULT, ok: true, canvasId: canvas.id, conversationId })
  ctx.log.info(
    `[canvas-chat] ${canvas.id.slice(0, 12)} -> ${conversationId.slice(0, 8)} ` +
      `selection=${selection ? `${selection.count}${selection.truncated ? ' (summarized)' : ''}` : 'none'} ` +
      `"${message.slice(0, 50)}"`,
  )
}

/** Handler map -- exported for direct unit testing; registered below. */
export const canvasChatHandlers = {
  canvas_chat_connect: canvasChatConnect,
  canvas_chat_send: canvasChatSend,
}

/** Control panel ONLY: a share guest must never drive the connected agent. */
export function registerCanvasChatHandlers(): void {
  registerHandlers(canvasChatHandlers, CONTROL_PANEL_ONLY)
}
