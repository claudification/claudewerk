/**
 * Card `node-stats-reporter-credential`, "Done means":
 *   "A second connection on the same key is refused."
 *
 * A key is a NODE, not a pool.
 */

import { afterEach, describe, expect, it } from 'bun:test'
import type { ServerWebSocket } from 'bun'
import type { WsData } from './handler-context'
import {
  bindReporterSocket,
  claimReporterSlot,
  connectedReporterIds,
  isReporterConnected,
  releaseReporterSlot,
  releaseReporterSocket,
  resetReporterSlots,
} from './reporter-connections'

function socket(data: Partial<WsData> = {}): ServerWebSocket<WsData> {
  return { data, send: () => {} } as unknown as ServerWebSocket<WsData>
}

afterEach(() => {
  resetReporterSlots()
})

describe('one connection per reporter key', () => {
  it('the first dial claims the slot', () => {
    expect(claimReporterSlot('rpt-1', 'beast', '10.0.0.1').ok).toBe(true)
    expect(isReporterConnected('rpt-1')).toBe(true)
  })

  it('a SECOND concurrent dial on the same key is REFUSED', () => {
    claimReporterSlot('rpt-1', 'beast', '10.0.0.1')
    const second = claimReporterSlot('rpt-1', 'beast', '10.0.0.99')
    expect(second.ok).toBe(false)
  })

  it('the refusal carries what the log line needs: who holds it, since when', () => {
    claimReporterSlot('rpt-1', 'beast', '10.0.0.1')
    const second = claimReporterSlot('rpt-1', 'beast', '10.0.0.99')
    expect(second.heldBy).toBe('10.0.0.1')
    expect(second.heldSince).toBeGreaterThan(0)
  })

  it('the INCUMBENT keeps the slot -- a second dial cannot displace a live node', () => {
    claimReporterSlot('rpt-1', 'beast', '10.0.0.1')
    claimReporterSlot('rpt-1', 'beast', '10.0.0.99')
    // Still exactly one holder, and it is the original.
    expect(connectedReporterIds()).toEqual(['rpt-1'])
    expect(claimReporterSlot('rpt-1', 'beast', '10.0.0.1').heldBy).toBe('10.0.0.1')
  })

  it('a DIFFERENT key is unaffected -- the limit is per key, not global', () => {
    expect(claimReporterSlot('rpt-1', 'beast').ok).toBe(true)
    expect(claimReporterSlot('rpt-2', 'prox01').ok).toBe(true)
    expect(connectedReporterIds().sort()).toEqual(['rpt-1', 'rpt-2'])
  })
})

describe('the slot is released so a node can dial back in', () => {
  it('releasing by socket frees the key for a reconnect', () => {
    const ws = socket({ reporterId: 'rpt-1' })
    claimReporterSlot('rpt-1', 'beast')
    bindReporterSocket('rpt-1', ws)
    expect(releaseReporterSocket(ws)).toBe('rpt-1')
    expect(claimReporterSlot('rpt-1', 'beast').ok).toBe(true)
  })

  it('a socket that closed BEFORE it was bound still frees its slot (no leak)', () => {
    const ws = socket({ reporterId: 'rpt-1' })
    claimReporterSlot('rpt-1', 'beast')
    // bindReporterSocket never ran -- close arrived first.
    expect(releaseReporterSocket(ws)).toBe('rpt-1')
    expect(isReporterConnected('rpt-1')).toBe(false)
  })

  it('a LATE close from a previous socket cannot evict the CURRENT holder', () => {
    const stale = socket({ reporterId: 'rpt-1' })
    const current = socket({ reporterId: 'rpt-1' })
    claimReporterSlot('rpt-1', 'beast')
    bindReporterSocket('rpt-1', current)
    // The stale socket carries the same reporterId, so the id fallback would
    // fire -- except the slot is BOUND to another socket. It must be left alone.
    expect(releaseReporterSocket(stale)).toBeUndefined()
    expect(isReporterConnected('rpt-1')).toBe(true)
    // The live socket still releases its own claim normally.
    expect(releaseReporterSocket(current)).toBe('rpt-1')
    expect(isReporterConnected('rpt-1')).toBe(false)
  })

  it('releasing by id frees a slot claimed but never upgraded', () => {
    claimReporterSlot('rpt-1', 'beast')
    expect(releaseReporterSlot('rpt-1')).toBe(true)
    expect(releaseReporterSlot('rpt-1')).toBe(false)
    expect(isReporterConnected('rpt-1')).toBe(false)
  })

  it('releasing an unknown socket is a no-op, not a crash', () => {
    expect(releaseReporterSocket(socket({}))).toBeUndefined()
  })
})
