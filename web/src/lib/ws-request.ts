/**
 * Request/reply over the conversation WebSocket.
 *
 * The socket is a one-way pipe with `requestId` correlation, so every feature
 * that asks the broker a question needs the same four things: a uuid, a timeout
 * that rejects, a pending map, and a settle step that matches a reply back to
 * its promise. That was copy-pasted per feature (board, nightshift watchdog);
 * this is the one implementation.
 *
 * `settle` returns false when the reply is not ours, so a handler that also
 * carries live pushes can keep routing them.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

const DEFAULT_TIMEOUT_MS = 12_000

interface Pending {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
}

export interface WsRequestChannel {
  /** Send `payload` with a fresh requestId; resolves on the matching reply. */
  send(payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Settle a reply. True if it belonged to this channel. */
  settle(msg: Record<string, unknown>): boolean
}

/** `label` names the channel in its timeout error ("board request timed out"). */
export function createWsRequestChannel(label: string, timeoutMs = DEFAULT_TIMEOUT_MS): WsRequestChannel {
  const pending = new Map<string, Pending>()

  return {
    send(payload) {
      const requestId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(requestId)
          reject(new Error(`${label} request timed out`))
        }, timeoutMs)
        pending.set(requestId, { resolve, reject, timeout })
        useConversationsStore.getState().sendWsMessage({ ...payload, requestId })
      })
    },

    settle(msg) {
      const requestId = msg.requestId as string | undefined
      if (!requestId) return false
      const hit = pending.get(requestId)
      if (!hit) return false
      clearTimeout(hit.timeout)
      pending.delete(requestId)
      if (msg.ok === false && msg.error) hit.reject(new Error(msg.error as string))
      else hit.resolve(msg)
      return true
    },
  }
}
