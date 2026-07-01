import { describe, expect, test } from 'bun:test'
import type { Conversation } from '../shared/protocol'
import { buildReviveMessage, conversationHasCcSession } from './build-revive'

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
  test('reads the profile NAME from conversation.resolvedProfile', () => {
    const conv = makeConversation({
      project: 'claude://default/Users/jonas/projects/foo',
      resolvedProfile: 'work',
    })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBe('work')
    expect(msg.project).toBe('claude://default/Users/jonas/projects/foo')
  })

  test('omits profile when the conversation has no resolvedProfile (default)', () => {
    const conv = makeConversation({ project: 'claude://default/Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBeUndefined()
  })

  test('override wins over conversation.resolvedProfile (recovery / test-only)', () => {
    const conv = makeConversation({
      project: 'claude://default/Users/jonas/projects/foo',
      resolvedProfile: 'work',
    })
    const msg = buildReviveMessage(conv, 'conv-2', { profile: 'alt' })
    expect(msg.profile).toBe('alt')
  })

  test('legacy triple-slash URI yields no profile (default)', () => {
    const conv = makeConversation({ project: 'claude:///Users/jonas/projects/foo' })
    const msg = buildReviveMessage(conv, 'conv-2')
    expect(msg.profile).toBeUndefined()
  })
})

describe('buildReviveMessage -- fork', () => {
  test('no fork fields on a plain revive', () => {
    const msg = buildReviveMessage(makeConversation(), 'conv-2')
    expect(msg.forkSession).toBeUndefined()
    expect(msg.resumeSessionAt).toBeUndefined()
  })

  test('forkSession + resumeSessionAt ride through to the revive message', () => {
    const conv = makeConversation({ agentHostMeta: { ccSessionId: 'cc-src' } })
    const msg = buildReviveMessage(conv, 'fork-2', { forkSession: true, resumeSessionAt: 'msg-uuid-42' })
    expect(msg.forkSession).toBe(true)
    expect(msg.resumeSessionAt).toBe('msg-uuid-42')
    // Fork resumes FROM the source ccSessionId, into the new conversationId.
    expect(msg.ccSessionId).toBe('cc-src')
    expect(msg.conversationId).toBe('fork-2')
  })

  test('forkSession without resumeSessionAt = fork from HEAD', () => {
    const msg = buildReviveMessage(makeConversation(), 'fork-2', { forkSession: true })
    expect(msg.forkSession).toBe(true)
    expect(msg.resumeSessionAt).toBeUndefined()
  })
})

describe('conversationHasCcSession', () => {
  test('true when a ccSessionId is present in agentHostMeta', () => {
    expect(conversationHasCcSession(makeConversation({ agentHostMeta: { ccSessionId: 'cc-abc' } }))).toBe(true)
  })

  test('false when the conversation never booted (no ccSessionId)', () => {
    expect(conversationHasCcSession(makeConversation({ agentHostMeta: {} }))).toBe(false)
    expect(conversationHasCcSession(makeConversation({ agentHostMeta: undefined }))).toBe(false)
  })
})
