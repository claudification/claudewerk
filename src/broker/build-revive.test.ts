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

  test('carries a stored thinkingSummaries opt-out through revive', () => {
    const conv = makeConversation({ launchConfig: { headless: true, thinkingSummaries: false } })
    expect(buildReviveMessage(conv, 'conv-2').thinkingSummaries).toBe(false)
  })

  test('leaves thinkingSummaries undefined for a pre-feature conversation (sentinel defaults it ON)', () => {
    const conv = makeConversation({ launchConfig: { headless: true } })
    expect(buildReviveMessage(conv, 'conv-2').thinkingSummaries).toBeUndefined()
  })

  test('override wins over the stored launch config', () => {
    const conv = makeConversation({ launchConfig: { headless: true, thinkingSummaries: false } })
    expect(buildReviveMessage(conv, 'conv-2', { thinkingSummaries: true }).thinkingSummaries).toBe(true)
  })
})
