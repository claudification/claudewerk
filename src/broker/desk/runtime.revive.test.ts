import { describe, expect, it } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import type { ConversationStore } from '../conversation-store'
import { type DispatchRuntime, executeRevive } from './runtime'

/** Minimal store stub -- only the methods executeRevive touches. */
function stubStore(over: {
  conv?: Partial<Conversation> | null
  activeCount?: number
  sentinel?: { sent: string[] } | null
}): { store: ConversationStore; resumed: string[]; sent: string[] } {
  const resumed: string[] = []
  const sent: string[] = []
  const sentinel = over.sentinel === null ? undefined : { send: (s: string) => sent.push(s) }
  const store = {
    getConversation: () =>
      over.conv === null ? undefined : ({ id: 'conv_x', project: 'p', status: 'ended', ...over.conv } as Conversation),
    getActiveConversationCount: () => over.activeCount ?? 0,
    getSentinel: () => sentinel,
    resumeConversation: (id: string) => resumed.push(id),
  } as unknown as ConversationStore
  return { store, resumed, sent }
}

function rt(store: ConversationStore): DispatchRuntime {
  return { store }
}

describe('executeRevive -- guard paths', () => {
  it('throws when the conversation is not found', () => {
    const { store } = stubStore({ conv: null })
    expect(() => executeRevive('conv_x', rt(store))).toThrow('not found')
  })

  it('throws when already active', () => {
    const { store } = stubStore({ conv: { status: 'active' } })
    expect(() => executeRevive('conv_x', rt(store))).toThrow('already active')
  })

  it('throws when a live agent host socket exists (prevents duplicate boot)', () => {
    const { store } = stubStore({ conv: { status: 'idle' }, activeCount: 1 })
    expect(() => executeRevive('conv_x', rt(store))).toThrow('already alive')
  })

  it('throws when no sentinel is connected', () => {
    const { store } = stubStore({ conv: { status: 'ended' }, sentinel: null })
    expect(() => executeRevive('conv_x', rt(store))).toThrow('no sentinel connected')
  })
})

describe('executeRevive -- happy path', () => {
  it('reuses the id, resumes, and sends a revive RPC to the sentinel', () => {
    const { store, resumed, sent } = stubStore({ conv: { status: 'ended' }, sentinel: { sent: [] } })
    const out = executeRevive('conv_x', rt(store))
    expect(out.conversationId).toBe('conv_x') // same id reused
    expect(resumed).toEqual(['conv_x'])
    expect(sent).toHaveLength(1)
    const msg = JSON.parse(sent[0]!)
    expect(msg.type).toBe('revive')
    expect(msg.conversationId).toBe('conv_x')
  })
})
