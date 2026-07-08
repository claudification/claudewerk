/**
 * Promise wrapper over the universal control-debug send path.
 *
 * `debug_control_send` -> broker (permission + danger gate) -> agent host ->
 * CC's cc_control channel, with the `debug_control_result` relayed back into
 * `debug-control-store`. The Login modal drives the 3-step Claude.ai OAuth flow
 * (`claude_authenticate` -> `claude_oauth_callback`) over this, so it needs each
 * command's outcome as an awaitable value rather than a trace-ring scan.
 */

import { type DebugTraceResult, getDebugTraceResult, startDebugTrace, subscribe } from '@/hooks/debug-control-store'
import { wsSend } from '@/hooks/use-conversations'

function randomTraceId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `trace-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
}

/**
 * Fire one cc_control command at a conversation and resolve with its result.
 * The trace is still recorded in the debug store, so the Debug modal shows it
 * too. Rejects on timeout only -- a broker/CC error comes back as a resolved
 * result with `ok: false` (the caller decides what a non-ok means).
 *
 * `timeoutMs` defaults high because a step like the user pasting a code is
 * bounded by the broker/CC round-trip, not the human -- the human happens
 * between two separate calls, not inside one.
 */
export function sendControlCommand(
  conversationId: string,
  command: string,
  payload: Record<string, unknown>,
  timeoutMs = 120_000,
): Promise<DebugTraceResult> {
  const traceId = randomTraceId()
  startDebugTrace({ traceId, conversationId, channel: 'cc_control', command })
  wsSend('debug_control_send', {
    traceId,
    targetConversation: conversationId,
    channel: 'cc_control',
    command,
    payload,
  })
  return new Promise((resolve, reject) => {
    const first = getDebugTraceResult(traceId)
    if (first) {
      resolve(first)
      return
    }
    const timer = setTimeout(() => {
      unsub()
      reject(new Error(`control command ${command} timed out`))
    }, timeoutMs)
    const unsub = subscribe(() => {
      const r = getDebugTraceResult(traceId)
      if (!r) return
      clearTimeout(timer)
      unsub()
      resolve(r)
    })
  })
}
