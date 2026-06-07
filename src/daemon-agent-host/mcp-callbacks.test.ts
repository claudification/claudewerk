/**
 * Tests for the daemon MCP-callbacks adapter. The shared builder is covered in
 * agent-host-common/host-rpc; here we assert the daemon-specific sinks fire the
 * right host-local machinery: plan-mode toggles the worker PTY, exit delegates
 * to the host shutdown, and a fresh pending registry is handed back for the
 * inbound dispatcher to resolve into.
 */

import { describe, expect, test } from 'bun:test'
import type { AttachHandle } from '../shared/cc-daemon/attach'
import { buildDaemonMcpCallbacks, type DaemonMcpCallbackDeps } from './mcp-callbacks'

function makeDeps(overrides: Partial<DaemonMcpCallbackDeps> = {}): DaemonMcpCallbackDeps {
  return {
    conversationId: 'conv-1',
    cwd: '/tmp/work',
    brokerUrl: 'ws://localhost:9999',
    brokerSecret: 'sek',
    transport: { send: () => {}, isConnected: () => true },
    getCcSessionId: () => null,
    diag: () => {},
    log: () => {},
    getAttachHandle: () => null,
    requestExit: () => {},
    ...overrides,
  }
}

describe('buildDaemonMcpCallbacks', () => {
  test('returns a callbacks object + a fresh pending registry', () => {
    const { callbacks, pending } = buildDaemonMcpCallbacks(makeDeps())
    expect(typeof callbacks.onNotify).toBe('function')
    expect(typeof callbacks.onListConversations).toBe('function')
    expect(typeof callbacks.onDialogShow).toBe('function')
    expect(pending.pendingListConversations).toBeNull()
  })

  test('onTogglePlanMode types /plan into a live worker PTY', () => {
    const writes: string[] = []
    const handle = { closed: false, writeInput: (d: string) => writes.push(d) } as unknown as AttachHandle
    const { callbacks } = buildDaemonMcpCallbacks(makeDeps({ getAttachHandle: () => handle }))
    callbacks.onTogglePlanMode?.()
    expect(writes).toEqual(['/plan\r'])
  })

  test('onTogglePlanMode is a no-op when the attach handle is closed', () => {
    const writes: string[] = []
    const handle = { closed: true, writeInput: (d: string) => writes.push(d) } as unknown as AttachHandle
    const { callbacks } = buildDaemonMcpCallbacks(makeDeps({ getAttachHandle: () => handle }))
    callbacks.onTogglePlanMode?.()
    expect(writes).toEqual([])
  })

  test('onExitConversation delegates to requestExit', () => {
    const calls: Array<[string, string | undefined]> = []
    const { callbacks } = buildDaemonMcpCallbacks(
      makeDeps({ requestExit: (status, message) => calls.push([status, message]) }),
    )
    callbacks.onExitConversation?.('error', 'bye')
    expect(calls).toEqual([['error', 'bye']])
  })

  test('onNotify forwards a notify message over the transport', () => {
    const sent: Array<Record<string, unknown>> = []
    const { callbacks } = buildDaemonMcpCallbacks(
      makeDeps({
        transport: { send: m => sent.push(m as unknown as Record<string, unknown>), isConnected: () => true },
      }),
    )
    callbacks.onNotify?.('hello', 'Title')
    expect(sent).toEqual([{ type: 'notify', conversationId: 'conv-1', message: 'hello', title: 'Title' }])
  })
})
