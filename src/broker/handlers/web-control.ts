/**
 * Web Debug Control handlers (broker side).
 *
 * Three control-panel-originated messages:
 *   web_control_advertise  -> register/refresh an opted-in browser
 *   web_control_revoke     -> explicit early opt-out
 *   web_control_response   -> resolve a pending web_control_request (by requestId)
 *
 * The outbound web_control_request is sent by the MCP `web_*` tools via
 * src/broker/web-control.ts (not a handler). All three are gated to the
 * control-panel role -- share viewers must never opt a browser into control.
 */

import { WEB_CONTROL_OPS, type WebControlOp } from '../../shared/protocol'
import type { HandlerContext, MessageData, MessageHandler } from '../handler-context'
import { registerHandlers } from '../message-router'
import { advertiseWebControl, resolveWebControlResponse, revokeWebControl } from '../web-control'

const OP_SET = new Set<string>(WEB_CONTROL_OPS)

function sanitizeCaps(raw: unknown): WebControlOp[] {
  if (!Array.isArray(raw)) return []
  return raw.filter((c): c is WebControlOp => typeof c === 'string' && OP_SET.has(c))
}

const webControlAdvertise: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const clientId = typeof data.clientId === 'string' ? data.clientId : ''
  const grantId = typeof data.grantId === 'string' ? data.grantId : ''
  const expiresAt = typeof data.expiresAt === 'number' ? data.expiresAt : 0
  const capabilities = sanitizeCaps(data.capabilities)
  const label = typeof data.label === 'string' ? data.label.slice(0, 200) : undefined

  if (!clientId || !grantId || !expiresAt || capabilities.length === 0) {
    ctx.reply({
      type: 'web_control_advertise_ack',
      ok: false,
      error: 'web_control_advertise requires clientId, grantId, expiresAt, and at least one capability',
    })
    return
  }

  const { expiresAt: effective } = advertiseWebControl(ctx.ws, {
    clientId,
    grantId,
    expiresAt,
    capabilities,
    label,
  })
  // Echo the broker-clamped expiry so the browser can align its local countdown.
  ctx.reply({ type: 'web_control_advertise_ack', ok: true, clientId, grantId, expiresAt: effective })
}

const webControlRevoke: MessageHandler = (ctx: HandlerContext, data: MessageData) => {
  const clientId = typeof data.clientId === 'string' ? data.clientId : ''
  if (clientId) revokeWebControl(clientId, 'client_revoke')
  ctx.reply({ type: 'web_control_revoke_ack', ok: true, clientId })
}

const webControlResponse: MessageHandler = (_ctx: HandlerContext, data: MessageData) => {
  const requestId = typeof data.requestId === 'string' ? data.requestId : ''
  if (!requestId) return
  resolveWebControlResponse({
    requestId,
    ok: data.ok !== false,
    result: data.result,
    error: typeof data.error === 'string' ? data.error : undefined,
  })
}

export function registerWebControlHandlers(): void {
  registerHandlers(
    {
      web_control_advertise: webControlAdvertise,
      web_control_revoke: webControlRevoke,
      web_control_response: webControlResponse,
    },
    ['control-panel'],
  )
}
