/**
 * DaemonControlResult builders -- map a daemon control-op outcome onto the
 * typed `daemon_control_result` wire message the control panel renders
 * (EVERYTHING IS A STRUCTURED MESSAGE: every reply / kill / respawn-stale /
 * permission-response op surfaces its outcome).
 *
 * Shared by the daemon-agent-host (which runs the daemon op and reports the
 * settled response) and the broker (which originates a failure result on the
 * path where it cannot even forward the control request -- no host socket).
 *
 * Pure -- no I/O, no ccSessionId. Safe to import from `src/broker/`
 * (`lint:boundary` stays clean: this module names no CC-session concept).
 */
import type { DaemonControlResult } from '../protocol'
import { ProtocolMismatchError } from './client'
import type { DaemonResponse } from './types'

/** The four remote-control ops Phase G surfaces a result for. */
export type DaemonControlOp = DaemonControlResult['op']

/**
 * Build a `DaemonControlResult` from a settled daemon op response. An
 * `{ ok: false }` daemon frame carries the daemon error code (`ENOREPLY`,
 * `ENOJOB`, ...) straight through so the user sees exactly why the op failed.
 */
export function controlResultFromResponse(
  conversationId: string,
  op: DaemonControlOp,
  resp: DaemonResponse,
): DaemonControlResult {
  if (resp.ok) {
    return { type: 'daemon_control_result', conversationId, op, ok: true, t: Date.now() }
  }
  return {
    type: 'daemon_control_result',
    conversationId,
    op,
    ok: false,
    code: resp.code ?? 'EUNKNOWN',
    detail: resp.error,
    t: Date.now(),
  }
}

/**
 * Build an explicit failure `DaemonControlResult` with a caller-chosen code.
 * Used by the broker when it cannot forward a control request at all
 * (`EHOSTGONE` -- the daemon-agent-host is not connected).
 */
export function controlResultFailure(
  conversationId: string,
  op: DaemonControlOp,
  code: string,
  detail: string,
): DaemonControlResult {
  return { type: 'daemon_control_result', conversationId, op, ok: false, code, detail, t: Date.now() }
}

/**
 * Build a failure `DaemonControlResult` from a thrown error. `request()`
 * throws on EPROTO (the proto gate -- never retried), on timeout and on a
 * dead socket. EPROTO is classified as `EPROTO`; everything else falls back
 * to `fallbackCode` (default `EUNKNOWN`).
 */
export function controlResultFromError(
  conversationId: string,
  op: DaemonControlOp,
  err: unknown,
  fallbackCode = 'EUNKNOWN',
): DaemonControlResult {
  const code = err instanceof ProtocolMismatchError ? 'EPROTO' : fallbackCode
  const detail = err instanceof Error ? err.message : String(err)
  return controlResultFailure(conversationId, op, code, detail)
}
