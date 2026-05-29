import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeAgentScopes,
  resetAgentScopes,
  resubscribeAgentScopes,
  subscribeAgentScope,
  unsubscribeAgentScope,
} from './agent-scope-subscription'

const CH = 'conversation:subagent_transcript'

beforeEach(() => resetAgentScopes())

describe('agent-scope subscription seam -- idempotency', () => {
  it('sends channel_subscribe exactly once on the 0->1 transition', () => {
    const send = vi.fn()
    subscribeAgentScope(send, 'conv', 'agent')
    subscribeAgentScope(send, 'conv', 'agent')
    subscribeAgentScope(send, 'conv', 'agent')
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'channel_subscribe',
      channel: CH,
      conversationId: 'conv',
      agentId: 'agent',
    })
  })

  it('sends channel_unsubscribe only on the last release (1->0)', () => {
    const send = vi.fn()
    subscribeAgentScope(send, 'conv', 'agent')
    subscribeAgentScope(send, 'conv', 'agent') // refcount 2
    send.mockClear()

    unsubscribeAgentScope(send, 'conv', 'agent') // 2 -> 1, no wire
    expect(send).not.toHaveBeenCalled()

    unsubscribeAgentScope(send, 'conv', 'agent') // 1 -> 0, wire fires
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith({
      type: 'channel_unsubscribe',
      channel: CH,
      conversationId: 'conv',
      agentId: 'agent',
    })
  })

  it('releasing an unheld scope is a no-op', () => {
    const send = vi.fn()
    unsubscribeAgentScope(send, 'conv', 'agent')
    expect(send).not.toHaveBeenCalled()
    expect(activeAgentScopes()).toEqual([])
  })

  it('ignores empty conversationId / agentId', () => {
    const send = vi.fn()
    subscribeAgentScope(send, '', 'agent')
    subscribeAgentScope(send, 'conv', '')
    expect(send).not.toHaveBeenCalled()
    expect(activeAgentScopes()).toEqual([])
  })
})

describe('agent-scope subscription seam -- open/close race', () => {
  it('keeps a scope alive when a second holder acquires before the first releases', () => {
    const send = vi.fn()
    // Detail view opens agent X.
    subscribeAgentScope(send, 'conv', 'X')
    // A PiP tile for the same agent acquires before the detail view closes.
    subscribeAgentScope(send, 'conv', 'X')
    send.mockClear()
    // Detail view closes -- scope must stay live for the PiP tile.
    unsubscribeAgentScope(send, 'conv', 'X')
    expect(send).not.toHaveBeenCalled()
    expect(activeAgentScopes()).toEqual([{ conversationId: 'conv', agentId: 'X' }])
  })
})

describe('agent-scope subscription seam -- multi-scope + reconnect', () => {
  it('tracks independent scopes', () => {
    const send = vi.fn()
    subscribeAgentScope(send, 'conv', 'a')
    subscribeAgentScope(send, 'conv', 'b')
    expect(activeAgentScopes()).toEqual([
      { conversationId: 'conv', agentId: 'a' },
      { conversationId: 'conv', agentId: 'b' },
    ])
  })

  it('round-trips an agentId containing a colon', () => {
    const send = vi.fn()
    subscribeAgentScope(send, 'conv', 'team:lead')
    expect(activeAgentScopes()).toEqual([{ conversationId: 'conv', agentId: 'team:lead' }])
  })

  it('re-subscribes every held scope without touching refcounts', () => {
    const send = vi.fn()
    subscribeAgentScope(send, 'conv', 'a')
    subscribeAgentScope(send, 'conv', 'a') // refcount 2
    subscribeAgentScope(send, 'conv', 'b')
    send.mockClear()

    resubscribeAgentScopes(send)
    // One subscribe per HELD scope (not per refcount): a, b.
    expect(send).toHaveBeenCalledTimes(2)
    expect(send).toHaveBeenCalledWith({ type: 'channel_subscribe', channel: CH, conversationId: 'conv', agentId: 'a' })
    expect(send).toHaveBeenCalledWith({ type: 'channel_subscribe', channel: CH, conversationId: 'conv', agentId: 'b' })

    // Counts intact: 'a' still needs two releases to drop.
    send.mockClear()
    unsubscribeAgentScope(send, 'conv', 'a')
    expect(send).not.toHaveBeenCalled()
  })
})
