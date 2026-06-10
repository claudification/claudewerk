/**
 * Web Debug Control -- reply primitives (client side).
 *
 * Tiny leaf shared by the dispatcher + op handlers: send a `web_control_response`
 * and raise a visibility toast. Kept separate so the op-handler file stays under
 * the size bar and there's no import cycle.
 */

import type { WebControlOp } from '@shared/protocol'
import type { TermResult } from './web-control-terminal'

export type Send = (msg: Record<string, unknown>) => void

export function respond(send: Send, requestId: string, ok: boolean, result?: unknown, error?: string): void {
  send({ type: 'web_control_response', requestId, ok, result, error })
}

export function toast(op: WebControlOp, detail: string): void {
  window.dispatchEvent(
    new CustomEvent('rclaude-toast', {
      detail: { title: 'Agent remote-control', body: `${op}${detail ? `: ${detail}` : ''}`, variant: 'info' },
    }),
  )
}

/** Relay a terminal-op result (TermResult) back, with a visibility toast. */
export function sendTerm(send: Send, requestId: string, op: WebControlOp, r: TermResult): void {
  const target = (r.result as { shellId?: string } | undefined)?.shellId
  toast(op, target ? target.slice(0, 12) : '')
  respond(send, requestId, r.ok, r.result, r.error)
}
