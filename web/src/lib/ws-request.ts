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
 *
 * A SEND THAT DID NOT HAPPEN IS NOT A SLOW ANSWER. `sendWsMessage` reports
 * whether the frame went out, and a closed socket means it did not. Waiting on
 * the reply timer in that case invents a story about the far end: a board card
 * clicked during a reconnect used to sit for twelve seconds and then blame the
 * sentinel by name, for a question the sentinel was never asked -- with nothing
 * in the broker log or the sentinel log, because nothing ever left the browser.
 * So an unsendable frame is RETRIED across the reconnect, and if the socket
 * still is not there it fails in a couple of seconds saying exactly that.
 */

import { useConversationsStore } from '@/hooks/use-conversations'

const DEFAULT_TIMEOUT_MS = 12_000
/** How long an unsendable frame waits for the socket to come back. Long enough
 *  to ride out a routine reconnect, short enough that a genuinely offline panel
 *  answers in seconds rather than on the reply timer. */
const DEFAULT_CONNECT_GRACE_MS = 4_000
const RETRY_MS = 50

interface Pending {
  resolve: (data: Record<string, unknown>) => void
  reject: (err: Error) => void
  timeout: ReturnType<typeof setTimeout>
  /** Stops the reconnect retry loop, if this frame never made it out. */
  stopRetry: () => void
}

export interface WsRequestChannel {
  /** Send `payload` with a fresh requestId; resolves on the matching reply. */
  send(payload: Record<string, unknown>): Promise<Record<string, unknown>>
  /** Settle a reply. True if it belonged to this channel. */
  settle(msg: Record<string, unknown>): boolean
}

/**
 * Put `frame` on the wire, retrying across a reconnect until `graceMs` is up.
 * Returns a canceller. `onGaveUp` fires only when the socket never came back.
 */
function deliver(frame: Record<string, unknown>, graceMs: number, onGaveUp: () => void): () => void {
  if (useConversationsStore.getState().sendWsMessage(frame)) return () => {}
  const deadline = Date.now() + graceMs
  const retry = setInterval(() => {
    if (useConversationsStore.getState().sendWsMessage(frame)) {
      clearInterval(retry)
      return
    }
    if (Date.now() >= deadline) {
      clearInterval(retry)
      console.warn(
        `[ws-request] socket never opened within ${graceMs}ms -- dropping ${String(frame.type)}` +
          ` (readyState=${useConversationsStore.getState().ws?.readyState ?? 'no socket'})`,
      )
      onGaveUp()
    }
  }, RETRY_MS)
  return () => clearInterval(retry)
}

/** `label` names the channel in its errors ("board request timed out"). */
export function createWsRequestChannel(
  label: string,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  connectGraceMs = DEFAULT_CONNECT_GRACE_MS,
): WsRequestChannel {
  const pending = new Map<string, Pending>()

  /** Drop a pending entry and clean up both of its timers. */
  function claim(requestId: string): Pending | undefined {
    const hit = pending.get(requestId)
    if (!hit) return undefined
    clearTimeout(hit.timeout)
    hit.stopRetry()
    pending.delete(requestId)
    return hit
  }

  return {
    send(payload) {
      const requestId = crypto.randomUUID()
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          claim(requestId)?.reject(new Error(`${label} request timed out`))
        }, timeoutMs)
        // Registered before the send, so a synchronous reply cannot beat it.
        pending.set(requestId, { resolve, reject, timeout, stopRetry: () => {} })
        const stopRetry = deliver({ ...payload, requestId }, connectGraceMs, () => {
          claim(requestId)?.reject(new Error(`${label} request failed: not connected to the broker`))
        })
        const entry = pending.get(requestId)
        if (entry) entry.stopRetry = stopRetry
        else stopRetry()
      })
    },

    settle(msg) {
      const requestId = msg.requestId as string | undefined
      if (!requestId) return false
      if (!pending.has(requestId)) return false
      const hit = claim(requestId)
      if (!hit) return false
      if (msg.ok === false && msg.error) hit.reject(new Error(msg.error as string))
      else hit.resolve(msg)
      return true
    },
  }
}
