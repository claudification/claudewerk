/**
 * In-flight `send_input` tracking.
 *
 * `wsSend` returning true only means the bytes left the browser -- it says
 * nothing about whether the broker accepted them. A conversation whose agent
 * host is disconnected fails server-side (`Conversation not connected`) AFTER
 * the input bar has already cleared optimistically, which used to lose the
 * text outright.
 *
 * Every send registers here under a `requestId`; the broker's
 * `send_input_result` resolves it. Anything that fails -- rejected, or still
 * in flight when the socket dies -- lands in the outbox for explicit retry.
 */

import { enqueueOutbox } from './outbox'

export type PendingSend = {
  requestId: string
  conversationId: string
  text: string
  source?: string
  at: number
}

/** Backstop only. The broker replies immediately in practice; a send still
 *  unresolved after this is assumed delivered (dropping it risks a duplicate
 *  outbox entry for a message that actually landed). */
const RESOLVE_TIMEOUT_MS = 30_000

const pending = new Map<string, PendingSend>()

export function newRequestId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID()
  return `si_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`
}

export function registerPendingSend(send: Omit<PendingSend, 'at'>): void {
  pending.set(send.requestId, { ...send, at: Date.now() })
  setTimeout(() => {
    if (!pending.delete(send.requestId)) return
    console.warn('[outbox] send_input never acknowledged, assuming delivered:', send.requestId)
  }, RESOLVE_TIMEOUT_MS)
}

/** Forget a send without queueing it (it never left the browser). */
export function discardPendingSend(requestId: string): PendingSend | undefined {
  const entry = pending.get(requestId)
  pending.delete(requestId)
  return entry
}

/** Oldest first -- the fallback target when a broker rejects without echoing
 *  a requestId. */
function oldestPending(): PendingSend | undefined {
  let oldest: PendingSend | undefined
  for (const entry of pending.values()) {
    if (!oldest || entry.at < oldest.at) oldest = entry
  }
  return oldest
}

/**
 * Apply a `send_input_result`. On failure the message goes to the outbox.
 * Returns the resolved send, or undefined when nothing matched (a success
 * reply from a broker too old to echo `requestId` -- the timeout reaps it).
 */
export function resolvePendingSend(
  requestId: string | undefined,
  ok: boolean,
  error = 'Not delivered',
): PendingSend | undefined {
  const entry = requestId ? pending.get(requestId) : ok ? undefined : oldestPending()
  if (!entry) return undefined
  pending.delete(entry.requestId)
  if (!ok) {
    enqueueOutbox({
      conversationId: entry.conversationId,
      text: entry.text,
      error,
      ...(entry.source && { source: entry.source }),
    })
  }
  return entry
}

/** Socket died with sends in flight -- none of them can be confirmed, so queue
 *  them all. Returns how many were queued. */
export function failAllPendingSends(error: string): number {
  const inFlight = [...pending.values()]
  pending.clear()
  for (const entry of inFlight) {
    enqueueOutbox({
      conversationId: entry.conversationId,
      text: entry.text,
      error,
      ...(entry.source && { source: entry.source }),
    })
  }
  return inFlight.length
}

/** Test seam. */
export function _resetPendingSends(): void {
  pending.clear()
}

export function pendingSendCount(): number {
  return pending.size
}
