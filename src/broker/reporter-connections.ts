/**
 * ONE CONNECTION PER REPORTER KEY. A key is a node, not a pool.
 *
 * A second concurrent connection presenting the same `rpt_` secret is REFUSED
 * at the WS upgrade -- before the socket exists -- and logged with both peers'
 * addresses. The incumbent is left alone: a live reporter is not knocked off by
 * whoever dials next, so a leaked key cannot be used to displace the real node.
 *
 * The slot is claimed at upgrade and released on close. A reporter whose socket
 * dies without a clean close holds its slot until Bun's idle timeout reaps the
 * socket (120s, with pings); the standalone reporter retries with backoff and
 * reconnects on the next attempt after that.
 */

import type { ServerWebSocket } from 'bun'
import type { WsData } from './handler-context'

interface ReporterSlot {
  reporterId: string
  alias: string
  claimedAt: number
  remoteAddr?: string
  ws?: ServerWebSocket<WsData>
}

const slots = new Map<string, ReporterSlot>()

export interface ClaimResult {
  ok: boolean
  /** Populated on refusal -- the incumbent's details, for the log line. */
  heldSince?: number
  heldBy?: string
}

/** Try to claim the single slot for this reporter key. */
export function claimReporterSlot(reporterId: string, alias: string, remoteAddr?: string): ClaimResult {
  const existing = slots.get(reporterId)
  if (existing) return { ok: false, heldSince: existing.claimedAt, heldBy: existing.remoteAddr ?? 'unknown' }
  slots.set(reporterId, { reporterId, alias, claimedAt: Date.now(), remoteAddr })
  return { ok: true }
}

/** Attach the socket once the upgrade succeeded. */
export function bindReporterSocket(reporterId: string, ws: ServerWebSocket<WsData>): void {
  const slot = slots.get(reporterId)
  if (slot) slot.ws = ws
}

/** Release by id. Used when an upgrade fails after the claim. */
export function releaseReporterSlot(reporterId: string): boolean {
  return slots.delete(reporterId)
}

/** Release by socket identity, so a stale claim from a previous connection is
 *  never dropped by a later socket's close. */
export function releaseReporterSocket(ws: ServerWebSocket<WsData>): string | undefined {
  for (const [reporterId, slot] of slots) {
    if (slot.ws === ws) {
      slots.delete(reporterId)
      return reporterId
    }
  }
  // Closed between upgrade and open, so no socket was ever bound: fall back to
  // the id the socket carries, or the slot leaks and the node is locked out.
  // Guarded on the slot being UNBOUND -- a stale socket carrying the same
  // reporterId must never release a live connection's claim.
  const id = ws.data?.reporterId
  if (!id) return undefined
  const slot = slots.get(id)
  if (slot && !slot.ws) {
    slots.delete(id)
    return id
  }
  return undefined
}

export function isReporterConnected(reporterId: string): boolean {
  return slots.has(reporterId)
}

export function connectedReporterIds(): string[] {
  return [...slots.keys()]
}

/** Tests only -- the module holds process-wide state. */
export function resetReporterSlots(): void {
  slots.clear()
}
