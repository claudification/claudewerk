/**
 * Routes the chat's inbound frames to the open canvas.
 *
 * Separate from canvas-collab-bus because that one owns a single listener per
 * canvasId for the multiplayer room (cursors, scene deltas), and the chat is a
 * different consumer of the same socket. Rather than multiplex two concerns
 * through one callback -- and risk the chat panel unmounting taking the room's
 * listener with it -- the chat gets its own registry, fed from the same store
 * handler.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

type ChatMsg = Record<string, unknown> & { canvasId?: string }
type Listener = (msg: ChatMsg) => void

const listeners = new Map<string, Listener>()
let installed = false

/** Frames the chat cares about. Anything else stays with the collab bus. */
const CHAT_TYPES = new Set(['canvas_chat_message', 'canvas_chat_connect_result', 'canvas_chat_send_result'])

export function isCanvasChatMessage(type: unknown): boolean {
  return CHAT_TYPES.has(String(type))
}

function install(): void {
  if (installed) return
  installed = true
  useConversationsStore.setState({
    canvasChatHandler: (msg: Record<string, unknown>) => {
      const id = (msg as ChatMsg).canvasId
      if (id) listeners.get(id)?.(msg as ChatMsg)
    },
  })
}

export function registerCanvasChatListener(canvasId: string, fn: Listener): void {
  install()
  listeners.set(canvasId, fn)
}

export function unregisterCanvasChatListener(canvasId: string): void {
  listeners.delete(canvasId)
}
