import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { buildReviveMessage } from './build-revive'

function makeConversation(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-1',
    project: 'claude://default/Users/jonas/projects/foo',
    status: 'idle',
    title: 'test',
    description: '',
    args: [],
    capabilities: [],
    events: [],
    createdAt: 0,
    lastActivity: 0,
    autocompactPct: undefined,
    maxBudgetUsd: undefined,
    agentHostMeta: { ccSessionId: 'cc-abc' },
    ...over,
  } as unknown as Conversation
}

describe('buildReviveMessage -- sentinel profile pin', () => {
  test('reads the profile NAME from the stored projectUri userinfo', () => {
    const conv = makeConversation({ project: 'claude://work@default/Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBe('work')
    // The original project URI (with profile) is forwarded intact for the
    // sentinel's reference -- the wire field is what pins.
    expect(msg.project).toBe('claude://work@default/Users/jonas/projects/foo')
  })

  test('omits profile when the conversation runs under the implicit default', () => {
    const conv = makeConversation({ project: 'claude://default/Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBeUndefined()
  })

  test('override wins over URI-derived profile (recovery / test-only path)', () => {
    const conv = makeConversation({ project: 'claude://work@default/Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2', { profile: 'alt' })
    expect(msg.profile).toBe('alt')
  })

  test('legacy triple-slash URI yields no profile (default)', () => {
    const conv = makeConversation({ project: 'claude:///Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBeUndefined()
  })

  test('never sends a SelectionMode token on the wire', () => {
    // Revive ALWAYS pins -- balanced/random can never end up here because the
    // sentinel's resolved name has already been written into the URI by spawn.
    const conv = makeConversation({ project: 'claude://alt@beast/home/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBe('alt')
    expect(msg.profile).not.toBe('balanced')
    expect(msg.profile).not.toBe('random')
  })
})
