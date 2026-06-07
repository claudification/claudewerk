/**
 * Web Debug Control registry + request/response correlation (broker side).
 *
 * An opted-in control-panel browser advertises a stable `clientId` plus a
 * time-boxed grant. The broker records the live socket here. MCP `web_*` tools
 * call `sendWebControlRequest(clientId, op, args)`, which sends a
 * `web_control_request` over that socket and returns a Promise resolved when the
 * browser's `web_control_response` arrives (matched by `requestId`) -- or rejected
 * to a timeout / disconnect.
 *
 * DEFAULT-DENY: a browser is only ever targeted if it has an entry here with an
 * unexpired grant. The broker enforces the 1h ceiling INDEPENDENTLY of the
 * browser's claim (advertised expiresAt is clamped on the way in, and re-checked
 * on every lookup), so a stale or hostile advertise cannot outlive the hour.
 *
 * Boundary-clean: this module never reads ccSessionId and stores no conversation
 * state -- it tracks browser sockets keyed by clientId, nothing more.
 */

import { randomUUID } from 'node:crypto'
import type { ServerWebSocket } from 'bun'
import { WEB_CONTROL_MAX_GRANT_MS, type WebControlOp } from '../shared/protocol'
import type { WsData } from './handler-context'

/** Public view of an opted-in browser (no socket handle). */
export interface WebControlClientInfo {
  clientId: string
  grantId: string
  label?: string
  userName?: string
  userAgent?: string
  capabilities: WebControlOp[]
  expiresAt: number
  connectedAt: number
  /** ms until the grant expires (clamped at 0). */
  ttlMs: number
}

interface RegistryEntry {
  ws: ServerWebSocket<WsData>
  clientId: string
  grantId: string
  label?: string
  userName?: string
  userAgent?: string
  capabilities: WebControlOp[]
  expiresAt: number
  connectedAt: number
}

export interface WebControlResult {
  ok: boolean
  result?: unknown
  error?: string
}

interface PendingEntry {
  resolve: (r: WebControlResult) => void
  timer: ReturnType<typeof setTimeout>
  clientId: string
  op: WebControlOp
}

const DEFAULT_OP_TIMEOUT_MS = 30_000
const SCREENSHOT_OP_TIMEOUT_MS = 60_000

/** clientId -> live entry. One entry per stable browser id. */
const clients = new Map<string, RegistryEntry>()
/** requestId -> pending control op. */
const pending = new Map<string, PendingEntry>()

function now(): number {
  return Date.now()
}

/** web -> broker: record (or refresh on reconnect) an opted-in browser. */
export function advertiseWebControl(
  ws: ServerWebSocket<WsData>,
  f: {
    clientId: string
    grantId: string
    expiresAt: number
    capabilities: WebControlOp[]
    label?: string
  },
): { expiresAt: number } {
  const t = now()
  // Broker-enforced ceiling: never trust a client-claimed expiry beyond 1h.
  const expiresAt = Math.min(f.expiresAt, t + WEB_CONTROL_MAX_GRANT_MS)
  const prev = clients.get(f.clientId)
  const userName = ws.data.userName
  const userAgent = ws.data.userAgent
  clients.set(f.clientId, {
    ws,
    clientId: f.clientId,
    grantId: f.grantId,
    label: f.label,
    userName,
    userAgent,
    capabilities: f.capabilities,
    expiresAt,
    connectedAt: t,
  })
  console.log(
    `[web-control] advertise client=${f.clientId} grant=${f.grantId} user=${userName ?? '?'} ` +
      `caps=[${f.capabilities.join(',')}] ttlMs=${expiresAt - t} ` +
      `${prev ? `(re-advertise, prevGrant=${prev.grantId})` : '(new)'}`,
  )
  return { expiresAt }
}

/** web -> broker: explicit early opt-out. */
export function revokeWebControl(clientId: string, reason = 'client_revoke'): void {
  const entry = clients.get(clientId)
  if (!entry) return
  clients.delete(clientId)
  console.log(`[web-control] revoke client=${clientId} grant=${entry.grantId} reason=${reason}`)
  failPendingForClient(clientId, `web client revoked (${reason})`)
}

/** Socket close: drop the entry that owns THIS socket (match by ws identity, so a
 *  reconnect that already re-advertised under a fresh socket is left intact). */
export function revokeWebControlBySocket(ws: ServerWebSocket<WsData>): void {
  for (const [clientId, entry] of clients) {
    if (entry.ws === ws) {
      clients.delete(clientId)
      console.log(`[web-control] socket-close drop client=${clientId} grant=${entry.grantId}`)
      failPendingForClient(clientId, 'web client disconnected')
    }
  }
}

function failPendingForClient(clientId: string, error: string): void {
  for (const [requestId, p] of pending) {
    if (p.clientId === clientId) {
      clearTimeout(p.timer)
      pending.delete(requestId)
      console.warn(`[web-control] fail pending req=${requestId} op=${p.op} client=${clientId}: ${error}`)
      p.resolve({ ok: false, error })
    }
  }
}

/** Look up a still-valid client, lazily evicting an expired one. */
function getLiveEntry(clientId: string): RegistryEntry | undefined {
  const entry = clients.get(clientId)
  if (!entry) return undefined
  if (now() >= entry.expiresAt) {
    clients.delete(clientId)
    console.log(`[web-control] grant expired (lazy evict) client=${clientId} grant=${entry.grantId}`)
    failPendingForClient(clientId, 'web control grant expired')
    return undefined
  }
  return entry
}

function toInfo(entry: RegistryEntry): WebControlClientInfo {
  return {
    clientId: entry.clientId,
    grantId: entry.grantId,
    label: entry.label,
    userName: entry.userName,
    userAgent: entry.userAgent,
    capabilities: entry.capabilities,
    expiresAt: entry.expiresAt,
    connectedAt: entry.connectedAt,
    ttlMs: Math.max(0, entry.expiresAt - now()),
  }
}

/** All currently opted-in (non-expired) browsers. */
export function listWebControlClients(): WebControlClientInfo[] {
  const out: WebControlClientInfo[] = []
  for (const clientId of [...clients.keys()]) {
    const entry = getLiveEntry(clientId)
    if (entry) out.push(toInfo(entry))
  }
  return out.sort((a, b) => b.connectedAt - a.connectedAt)
}

/**
 * Resolve the single implicit target when the caller omits `clientId`:
 *   0 clients -> error; 1 -> that one; >1 -> error listing choices.
 */
export function resolveImplicitClient(): { clientId: string } | { error: string } {
  const live = listWebControlClients()
  if (live.length === 0) {
    return {
      error: 'No browser is opted-in to remote control. Enable it in the control panel (Settings > System > Debug).',
    }
  }
  if (live.length > 1) {
    const choices = live.map(c => `${c.clientId} (${c.label ?? c.userName ?? 'browser'})`).join(', ')
    return { error: `Multiple browsers are opted-in; pass clientId. Choices: ${choices}` }
  }
  return { clientId: live[0].clientId }
}

/** Send an op to an opted-in browser and await its reply (or timeout/disconnect). */
export async function sendWebControlRequest(
  clientId: string,
  op: WebControlOp,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number },
): Promise<WebControlResult> {
  const entry = getLiveEntry(clientId)
  if (!entry) {
    return { ok: false, error: `No opted-in browser '${clientId}' (not advertised, disconnected, or grant expired).` }
  }
  if (!entry.capabilities.includes(op)) {
    return {
      ok: false,
      error: `Browser '${clientId}' does not support op '${op}' (caps: ${entry.capabilities.join(',')}).`,
    }
  }
  const requestId = `wcr_${randomUUID().slice(0, 12)}`
  const timeoutMs = opts?.timeoutMs ?? (op === 'screenshot' ? SCREENSHOT_OP_TIMEOUT_MS : DEFAULT_OP_TIMEOUT_MS)
  return new Promise<WebControlResult>(resolve => {
    const timer = setTimeout(() => {
      pending.delete(requestId)
      console.warn(`[web-control] TIMEOUT op=${op} client=${clientId} req=${requestId} after ${timeoutMs}ms`)
      resolve({ ok: false, error: `Browser timed out after ${timeoutMs}ms (op=${op}).` })
    }, timeoutMs)
    pending.set(requestId, { resolve, timer, clientId, op })
    try {
      entry.ws.send(JSON.stringify({ type: 'web_control_request', requestId, clientId, op, args: args ?? {} }))
      console.log(`[web-control] -> client=${clientId} op=${op} req=${requestId} timeoutMs=${timeoutMs}`)
    } catch (e) {
      clearTimeout(timer)
      pending.delete(requestId)
      console.error(`[web-control] send failed op=${op} client=${clientId} req=${requestId}: ${e}`)
      resolve({ ok: false, error: `Failed to reach browser: ${e instanceof Error ? e.message : String(e)}` })
    }
  })
}

/** web -> broker: resolve the pending op for this requestId. Late/unmatched = no-op. */
export function resolveWebControlResponse(payload: {
  requestId: string
  ok: boolean
  result?: unknown
  error?: string
}): boolean {
  const p = pending.get(payload.requestId)
  if (!p) {
    console.warn(`[web-control] late/unmatched response req=${payload.requestId} (no pending op)`)
    return false
  }
  clearTimeout(p.timer)
  pending.delete(payload.requestId)
  console.log(
    `[web-control] <- client=${p.clientId} op=${p.op} req=${payload.requestId} ok=${payload.ok}` +
      `${payload.error ? ` error=${payload.error}` : ''}`,
  )
  p.resolve({ ok: payload.ok !== false, result: payload.result, error: payload.error })
  return true
}

/** Test seam: wipe all state. */
export function __resetWebControlForTests(): void {
  for (const p of pending.values()) clearTimeout(p.timer)
  pending.clear()
  clients.clear()
}
