/**
 * Draining the pending-RPC registries, in the right order.
 *
 * A host awaits replies through TWO independent registries and must offer every
 * inbound message to BOTH:
 *
 *   - `host-rpc`   -- callback-style replies (dialog answers, inter-conversation
 *                     `*_result`), keyed in the per-host `PendingCallbacks`.
 *   - `broker-rpc` -- the promises the broker-backed tools await: `recap_*`,
 *                     `sotu_*`, `web_control_relay_response`, `schedule_result`.
 *
 * Draining only the first is a silent failure, not a loud one: the tool call
 * simply hangs until its 15s timeout and reports "broker rpc timeout", which
 * reads like a broker problem rather than a routing one. That is exactly what
 * the daemon host did before this existed.
 *
 * Both dispatchers no-op on a requestId they did not mint, so offering a message
 * to both is safe and the order only decides who claims a collision.
 */

import { dispatchHostRpcResult, type PendingCallbacks } from '../host-rpc'
import type { DiagSink } from '../host-rpc/context'
import { dispatchBrokerRpcResponse } from './mcp-tools/lib/broker-rpc'

const NO_DIAG: DiagSink = () => {}

/** True when the message was consumed by either registry and must not be
 *  routed on to normal handling. */
export function drainRpcReplies(
  msg: Record<string, unknown>,
  pending: PendingCallbacks,
  diag: DiagSink = NO_DIAG,
): boolean {
  if (dispatchHostRpcResult(msg, pending, diag)) return true
  return dispatchBrokerRpcResponse(msg)
}
