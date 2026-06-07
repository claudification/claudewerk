import { describe, expect, test } from 'bun:test'
import type { AgentHostMessage } from '../../shared/protocol'
import { buildMcpChannelCallbacks } from './index'
import type { HostRpcContext, HostSinks } from './context'
import { createPendingCallbacks, type PendingCallbacks } from './pending-callbacks'

/** A fake HostTransport that captures outbound messages and reports connected. */
function fakeTransport(connected = true) {
  const sent: AgentHostMessage[] = []
  return {
    sent,
    transport: {
      send(msg: AgentHostMessage) {
        sent.push(msg)
      },
      isConnected() {
        return connected
      },
    },
  }
}

const noopSinks: HostSinks = {
  deliverMessage() {},
  permissionAllow() {},
  registerPermissionRequest() {},
  dialogShow() {},
  dialogDismiss() {},
  togglePlanMode() {},
  exit() {},
}

function makeCtx(
  overrides: Partial<HostRpcContext> & { pending: PendingCallbacks; transport: HostRpcContext['transport'] },
): HostRpcContext {
  return {
    conversationId: 'conv-1',
    getCcSessionId: () => null,
    cwd: '/tmp/work',
    headless: false,
    noBroker: false,
    brokerUrl: 'ws://localhost:9999',
    brokerSecret: undefined,
    diag: () => {},
    permissionRules: { shouldAutoApprove: () => false },
    sinks: noopSinks,
    ...overrides,
  }
}

describe('host-rpc roundtrip', () => {
  test('onSendMessage sends channel_send and resolves on the dispatched result', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport }))

    const promise = cb.onSendMessage!('peer', 'request', 'hello', undefined, undefined)

    // One channel_send went out, addressed from this conversation.
    expect(sent).toHaveLength(1)
    const msg = sent[0] as unknown as Record<string, unknown>
    expect(msg.type).toBe('channel_send')
    expect(msg.fromConversation).toBe('conv-1')
    expect(msg.toConversation).toBe('peer')
    expect(msg.message).toBe('hello')

    // A resolver is now armed; the broker's inbound handler invokes it.
    expect(pending.pendingSendResult).not.toBeNull()
    pending.pendingSendResult!({ ok: true, status: 'delivered', targetConversationId: 'peer-cc' })

    const result = await promise
    expect(result.ok).toBe(true)
    expect(result.status).toBe('delivered')
    // Resolver is cleared so a stale second dispatch is a no-op.
    expect(pending.pendingSendResult).toBeNull()
  })

  test('fromConversation uses the cc session id once promoted', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport, getCcSessionId: () => 'cc-abc' }))

    void cb.onSendMessage!('peer', 'request', 'hi')
    const msg = sent[0] as unknown as Record<string, unknown>
    expect(msg.fromConversation).toBe('cc-abc')
  })

  test('onListConversations resolves with the dispatched roster', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport }))

    const promise = cb.onListConversations!('live', true, 'standard', undefined)
    const msg = sent[0] as unknown as Record<string, unknown>
    expect(msg.type).toBe('channel_list_conversations')
    expect(msg.status).toBe('live')
    expect(msg.show_metadata).toBe(true)

    pending.pendingListConversations!(
      [{ id: 'c1', name: 'one', status: 'live' }],
      { id: 'self' },
      [{ severity: 'warning', code: 'x', message: 'm' }],
    )
    const result = await promise
    expect(result.conversations).toHaveLength(1)
    expect(result.conversations[0].id).toBe('c1')
    expect(result.self).toEqual({ id: 'self' })
    expect(result.issues?.[0].code).toBe('x')
  })

  test('onControlConversation forwards action + optional model/effort and resolves', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport, getCcSessionId: () => 'cc-z' }))

    const promise = cb.onControlConversation!({ conversationId: 'tgt', action: 'set_model', model: 'opus' })
    const msg = sent[0] as unknown as Record<string, unknown>
    expect(msg.type).toBe('conversation_control')
    expect(msg.targetConversation).toBe('tgt')
    expect(msg.action).toBe('set_model')
    expect(msg.model).toBe('opus')
    expect(msg.effort).toBeUndefined()
    expect(msg.fromConversation).toBe('cc-z')

    pending.pendingControlResult!({ ok: true, name: 'Target' })
    expect((await promise).ok).toBe(true)
  })

  test('onRenameConversation defaults to self when no target is given', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport }))

    const promise = cb.onRenameConversation!('New Name', 'desc')
    const msg = sent[0] as unknown as Record<string, unknown>
    expect(msg.type).toBe('rename_conversation')
    expect(msg.conversationId).toBe('conv-1')
    expect(msg.name).toBe('New Name')

    pending.pendingRenameResult!({ ok: true })
    expect((await promise).ok).toBe(true)
  })

  test('inter-conversation calls short-circuit when the transport is down', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport(false)
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport }))

    expect(await cb.onSendMessage!('peer', 'request', 'x')).toEqual({ ok: false, error: 'Not connected' })
    expect(await cb.onReviveConversation!('peer')).toEqual({ ok: false, error: 'Not connected to broker' })
    expect(await cb.onListConversations!()).toEqual({ conversations: [] })
    // Nothing was queued -- the guard fired before any send.
    expect(sent).toHaveLength(0)
  })

  test('spawn_conversation runs the two-phase channel_spawn + rendezvous handshake', async () => {
    const pending = createPendingCallbacks()
    const { sent, transport } = fakeTransport()
    const cb = buildMcpChannelCallbacks(makeCtx({ pending, transport }))

    const promise = cb.onSpawnConversation!({ cwd: '/tmp/spawned', message: 'go' } as never)

    // Phase 1: channel_spawn out, resolver armed.
    const spawnMsg = sent[0] as unknown as Record<string, unknown>
    expect(spawnMsg.type).toBe('channel_spawn')
    expect(typeof spawnMsg.requestId).toBe('string')
    expect(pending.pendingSpawnRequestId).toBe(spawnMsg.requestId as string)

    pending.pendingSpawnResult!({ ok: true, conversationId: 'spawned-1' })

    // Phase 2: rendezvous keyed on the new conversation id resolves the wait.
    await Promise.resolve()
    const rendezvous = pending.pendingRendezvous.get('spawned-1')
    expect(rendezvous).toBeDefined()
    rendezvous!.resolve({ ccSessionId: 'cc-new', conversation: { id: 'spawned-1' } })

    const result = (await promise) as { ok: boolean; conversationId?: string; conversation?: { id: string } }
    expect(result.ok).toBe(true)
    expect(result.conversationId).toBe('spawned-1')
    expect(result.conversation?.id).toBe('spawned-1')
  })
})
