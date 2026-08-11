/**
 * Regression: the daemon host drained only ONE of its two pending-RPC
 * registries, so every broker-backed tool (recap_*, sotu_*, web_control_*, and
 * the schedule_* CRUD) hung until its 15s timeout and then blamed the broker.
 *
 * The bug was invisible precisely because it failed as a TIMEOUT rather than an
 * error, so the test that matters is: a broker-rpc reply is CONSUMED here, and
 * a message belonging to neither registry is passed through untouched.
 */

import { afterEach, beforeEach, expect, test } from 'bun:test'
import { createPendingCallbacks } from '../host-rpc'
import { _resetBrokerRpc, brokerRpc, setBrokerRpcSender } from './mcp-tools/lib/broker-rpc'
import { drainRpcReplies } from './rpc-drain'

beforeEach(() => _resetBrokerRpc())
afterEach(() => _resetBrokerRpc())

test('a broker-rpc reply is consumed and resolves the awaiting tool', async () => {
  let sentId = ''
  setBrokerRpcSender(msg => {
    sentId = String((msg as unknown as Record<string, unknown>).requestId)
  })
  const inflight = brokerRpc('schedule_list_request')

  const consumed = drainRpcReplies({ type: 'schedule_result', requestId: sentId, ok: true }, createPendingCallbacks())

  expect(consumed).toBe(true)
  await expect(inflight).resolves.toMatchObject({ ok: true })
})

test('a message belonging to neither registry falls through to normal handling', () => {
  expect(drainRpcReplies({ type: 'terminal_data', data: 'x' }, createPendingCallbacks())).toBe(false)
})

test('a reply with an id we never minted is NOT swallowed', () => {
  setBrokerRpcSender(() => {})
  expect(drainRpcReplies({ type: 'schedule_result', requestId: 'not-ours' }, createPendingCallbacks())).toBe(false)
})
