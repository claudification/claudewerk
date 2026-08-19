/**
 * Card `node-stats-reporter-credential`, "Done means" line 1:
 *   "A reporter key sends vitals and is REJECTED (with a logged reason) on every
 *    other message type."
 *
 * Drives the REAL router, so the gate is exercised exactly as shipped --
 * including against handlers registered with NO role list, which is the case
 * the per-handler role gate alone would not cover.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { NODE_STATS_MESSAGE } from '../../shared/node-stats'
import { ANY_ROLE, registerHandlers, routeMessage } from '../message-router'
import { nodeStatsStore } from '../node-stats-store'
import { registerAllHandlers } from './index'
import { asDashboard, asReporter, frame } from './node-stats-harness'

registerAllHandlers()

// A handler with NO role list -- the legacy any-role default.
let legacyHits = 0
registerHandlers({ legacy_open_handler: () => void legacyHits++ })
// And one explicitly registered for ANY_ROLE.
let anyRoleHits = 0
registerHandlers({ any_role_handler: () => void anyRoleHits++ }, ANY_ROLE)

beforeEach(() => {
  nodeStatsStore.clear()
  legacyHits = 0
  anyRoleHits = 0
})

describe('a reporter key is REJECTED on every other message type', () => {
  const forbidden = [
    'sentinel_identify',
    'spawn_result',
    'heartbeat',
    'shell_open',
    'sentinel_usage_report',
    'channel_subscribe',
    'meta',
    'legacy_open_handler',
    'any_role_handler',
    'type_that_does_not_exist',
  ]

  for (const type of forbidden) {
    it(`refuses ${type} WITH A LOGGED REASON`, () => {
      const h = asReporter()
      // Handled = true even for an unknown type: refusing loudly beats silently
      // falling through as "unhandled".
      expect(routeMessage(h.ctx, type, { type })).toBe(true)
      expect(h.replies.some(r => r.type === `${type}_result` && r.ok === false)).toBe(true)
      expect(h.logs.some(l => l.includes('capability reject') && l.includes(type))).toBe(true)
    })
  }

  it('an any-role / no-role handler is UNREACHABLE from a reporter socket', () => {
    const h = asReporter()
    routeMessage(h.ctx, 'legacy_open_handler', {})
    routeMessage(h.ctx, 'any_role_handler', {})
    expect(legacyHits).toBe(0)
    expect(anyRoleHits).toBe(0)
  })

  it('but those same handlers still work for a normal connection', () => {
    const h = asDashboard()
    routeMessage(h.ctx, 'legacy_open_handler', {})
    routeMessage(h.ctx, 'any_role_handler', {})
    expect(legacyHits).toBe(1)
    expect(anyRoleHits).toBe(1)
  })

  it('echoes requestId on refusal so an RPC caller sees the error instead of a timeout', () => {
    const h = asReporter()
    routeMessage(h.ctx, 'spawn_result', { requestId: 'req-7' })
    expect(h.replies[0].requestId).toBe('req-7')
  })

  it('the ONE allowed type still gets through', () => {
    const h = asReporter()
    expect(routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())).toBe(true)
    expect(h.replies.some(r => r.ok === false)).toBe(false)
    expect(nodeStatsStore.size()).toBe(1)
  })
})

describe('a socket with no node credential cannot report at all', () => {
  it('refuses a dashboard socket that forges a node_stats frame', () => {
    const h = asDashboard()
    routeMessage(h.ctx, NODE_STATS_MESSAGE, frame())
    expect(nodeStatsStore.size()).toBe(0)
    expect(h.replies.some(r => r.ok === false)).toBe(true)
  })
})
