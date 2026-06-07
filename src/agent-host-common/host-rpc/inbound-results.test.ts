/**
 * Tests for the inbound broker-RPC result router. The daemon host relies on this
 * to resolve the same pending-RPC registry the lifted callbacks register into,
 * so a `list_conversations` / `spawn` / `dialog`-adjacent reply lands on the
 * right resolver. Covers the happy path, the spawn stale-requestId guard, and
 * the rendezvous resolve/reject split.
 */

import { describe, expect, test } from 'bun:test'
import { dispatchHostRpcResult } from './inbound-results'
import { createPendingCallbacks } from './pending-callbacks'

const noopDiag = () => {}

describe('dispatchHostRpcResult', () => {
  test('routes channel_conversations_list to the list resolver', () => {
    const pending = createPendingCallbacks()
    let got: unknown
    pending.pendingListConversations = sessions => {
      got = sessions
    }
    const handled = dispatchHostRpcResult(
      { type: 'channel_conversations_list', conversations: [{ id: 'a' }] },
      pending,
      noopDiag,
    )
    expect(handled).toBe(true)
    expect(got).toEqual([{ id: 'a' }])
  })

  test('routes channel_send_result to the send resolver', () => {
    const pending = createPendingCallbacks()
    let got: unknown
    pending.pendingSendResult = r => {
      got = r
    }
    expect(dispatchHostRpcResult({ type: 'channel_send_result', ok: true }, pending, noopDiag)).toBe(true)
    expect(got).toEqual({ type: 'channel_send_result', ok: true })
  })

  test('drops a stale channel_spawn_result (requestId mismatch)', () => {
    const pending = createPendingCallbacks()
    pending.pendingSpawnRequestId = 'req-expected'
    let fired = false
    pending.pendingSpawnResult = () => {
      fired = true
    }
    const handled = dispatchHostRpcResult(
      { type: 'channel_spawn_result', requestId: 'req-other', ok: true },
      pending,
      noopDiag,
    )
    expect(handled).toBe(true)
    expect(fired).toBe(false)
  })

  test('delivers a matching channel_spawn_result', () => {
    const pending = createPendingCallbacks()
    pending.pendingSpawnRequestId = 'req-1'
    let got: { conversationId?: string } | null = null
    pending.pendingSpawnResult = r => {
      got = r
    }
    dispatchHostRpcResult(
      { type: 'channel_spawn_result', requestId: 'req-1', ok: true, conversationId: 'conv-x' },
      pending,
      noopDiag,
    )
    expect(got).toMatchObject({ conversationId: 'conv-x' })
  })

  test('routes spawn_diagnostics_result by jobId and clears the entry', () => {
    const pending = createPendingCallbacks()
    let got: unknown
    pending.pendingSpawnDiagnostics.set('job-1', r => {
      got = r
    })
    dispatchHostRpcResult({ type: 'spawn_diagnostics_result', jobId: 'job-1', ok: true }, pending, noopDiag)
    expect(got).toMatchObject({ jobId: 'job-1' })
    expect(pending.pendingSpawnDiagnostics.has('job-1')).toBe(false)
  })

  test('routes launch job events to the per-job listener', () => {
    const pending = createPendingCallbacks()
    const events: unknown[] = []
    pending.launchJobListeners.set('job-9', e => events.push(e))
    dispatchHostRpcResult({ type: 'launch_progress', jobId: 'job-9', pct: 50 }, pending, noopDiag)
    expect(events).toEqual([{ type: 'launch_progress', jobId: 'job-9', pct: 50 }])
  })

  test('resolves a spawn rendezvous on spawn_ready', () => {
    const pending = createPendingCallbacks()
    let resolved: unknown
    pending.pendingRendezvous.set('conv-r', { resolve: m => (resolved = m), reject: () => {} })
    dispatchHostRpcResult({ type: 'spawn_ready', conversationId: 'conv-r', ccSessionId: 'cc-1' }, pending, noopDiag)
    expect(resolved).toMatchObject({ ccSessionId: 'cc-1' })
    expect(pending.pendingRendezvous.has('conv-r')).toBe(false)
  })

  test('rejects a spawn rendezvous on spawn_timeout', () => {
    const pending = createPendingCallbacks()
    let rejected: unknown
    pending.pendingRendezvous.set('conv-t', { resolve: () => {}, reject: e => (rejected = e) })
    dispatchHostRpcResult({ type: 'spawn_timeout', conversationId: 'conv-t', error: 'boom' }, pending, noopDiag)
    expect(rejected).toBe('boom')
  })

  test('consumes dialog_result / dialog_keepalive (routed to dialog state)', () => {
    const pending = createPendingCallbacks()
    // No channel initialized -> resolveDialog/keepaliveDialog no-op, but the
    // dispatcher still claims the message so it never falls through to the PTY.
    expect(dispatchHostRpcResult({ type: 'dialog_result', dialogId: 'd1', result: {} }, pending, noopDiag)).toBe(true)
    expect(dispatchHostRpcResult({ type: 'dialog_keepalive', dialogId: 'd1' }, pending, noopDiag)).toBe(true)
  })

  test('returns false for an unrelated message (host falls through)', () => {
    const pending = createPendingCallbacks()
    expect(dispatchHostRpcResult({ type: 'terminal_data', data: 'x' }, pending, noopDiag)).toBe(false)
    expect(dispatchHostRpcResult({ type: undefined as unknown as string }, pending, noopDiag)).toBe(false)
  })
})
