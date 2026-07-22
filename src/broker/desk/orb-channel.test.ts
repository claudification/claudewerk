import { describe, expect, test } from 'bun:test'
import type { ConversationStore } from '../conversation-store'
import { buildOrbChannelDelivery, orbSourceName, parseOrbTarget, relayToOrb } from './orb-channel'

describe('parseOrbTarget', () => {
  test('bare orb -> all instances', () => {
    expect(parseOrbTarget('orb')).toEqual({ isOrb: true, orbId: null })
  })
  test('orb:xyz -> one instance', () => {
    expect(parseOrbTarget('orb:abc123')).toEqual({ isOrb: true, orbId: 'abc123' })
  })
  test('orb: with empty id -> treated as all', () => {
    expect(parseOrbTarget('orb:')).toEqual({ isOrb: true, orbId: null })
  })
  test('a normal conversation address is not the orb', () => {
    expect(parseOrbTarget('wandershelf:auth-refactor').isOrb).toBe(false)
    expect(parseOrbTarget('dispatcher').isOrb).toBe(false)
  })
})

describe('orbSourceName', () => {
  test('prefers title, then project label, then a short id', () => {
    expect(orbSourceName({ id: 'conv_abcdef01', title: 'auth refactor' })).toBe('auth refactor')
    expect(orbSourceName({ id: 'conv_abcdef01', title: '  ', projectLabel: 'wandershelf' })).toBe('wandershelf')
    expect(orbSourceName({ id: 'conv_abcdef0123' })).toBe('conv_abc')
  })
})

describe('buildOrbChannelDelivery', () => {
  test('wraps the body in a voice_orb_deliver envelope (all instances by default)', () => {
    const d = buildOrbChannelDelivery({ id: 'conv_x', title: 'the arr one' }, 'movies are ready', 1234)
    expect(d).toEqual({
      type: 'voice_orb_deliver',
      sourceConversationId: 'conv_x',
      sourceName: 'the arr one',
      body: 'movies are ready',
      ts: 1234,
      targetOrbId: null,
    })
  })
  test('carries the target instance id when addressed', () => {
    const d = buildOrbChannelDelivery({ id: 'c', title: 't' }, 'b', 1, 'orb-abc')
    expect(d.targetOrbId).toBe('orb-abc')
  })
})

/** Minimal store: enough for resolveSource + broadcastToSubscribers. */
function fakeStore(opts: { conv?: { title?: string; project?: string }; panels: number }): {
  store: ConversationStore
  sent: string[]
} {
  const sent: string[] = []
  const subscribers = new Set(Array.from({ length: opts.panels }, () => ({ send: (j: string) => sent.push(j) })))
  const store = {
    getConversation: () => (opts.conv ? { title: opts.conv.title, project: opts.conv.project } : undefined),
    getSubscribers: () => subscribers,
    getSubscriberCount: () => subscribers.size,
  } as unknown as ConversationStore
  return { store, sent }
}

describe('relayToOrb', () => {
  test('names the source and broadcasts to every panel (targetOrbId null = all)', () => {
    const { store, sent } = fakeStore({ conv: { title: 'deploy', project: 'claude:///infra' }, panels: 2 })
    const res = relayToOrb(store, 'conv_deploy', 'the deploy is blocked on you', null, 999)
    expect(res.ok).toBe(true)
    expect(res.subscribers).toBe(2)
    expect(res.sourceName).toBe('deploy')
    expect(sent).toHaveLength(2)
    expect(JSON.parse(sent[0])).toMatchObject({
      type: 'voice_orb_deliver',
      sourceName: 'deploy',
      body: 'the deploy is blocked on you',
      sourceConversationId: 'conv_deploy',
      targetOrbId: null,
      ts: 999,
    })
  })

  test('stamps the target instance id on the envelope', () => {
    const { store, sent } = fakeStore({ conv: { title: 'x' }, panels: 1 })
    relayToOrb(store, 'conv_x', 'just you', 'orb-9', 1)
    expect(JSON.parse(sent[0]).targetOrbId).toBe('orb-9')
  })

  test('no panels connected: ok, but subscribers=0 (message dropped, best-effort)', () => {
    const { store, sent } = fakeStore({ conv: { title: 'x' }, panels: 0 })
    const res = relayToOrb(store, 'conv_x', 'anyone there?')
    expect(res.ok).toBe(true)
    expect(res.subscribers).toBe(0)
    expect(sent).toHaveLength(0)
  })

  test('falls back to the project label when the conversation has no title', () => {
    const { store } = fakeStore({ conv: { project: 'claude:///wandershelf' }, panels: 1 })
    const res = relayToOrb(store, 'conv_untitled', 'hi')
    expect(res.sourceName).toBe('wandershelf')
  })
})
