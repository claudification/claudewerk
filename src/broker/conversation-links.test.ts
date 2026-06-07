/**
 * Tests for the persistent conversation-pair link store (ctx.convLinks). Keyed by
 * sorted conv-id pair, order-independent, backed by a KVStore. Mirror of project-links
 * but conv-scoped (opaque ids, no URI canonicalization).
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import {
  addPersistedConvLink,
  findConvLink,
  getConvLinksFor,
  initConversationLinks,
  removePersistedConvLink,
  touchConvLink,
} from './conversation-links'
import type { KVStore } from './store/types'

function makeKv(): KVStore {
  const map = new Map<string, unknown>()
  return {
    get: <T>(key: string) => (map.has(key) ? (map.get(key) as T) : null),
    set: (key, value) => {
      map.set(key, value)
    },
    delete: (key: string) => map.delete(key),
    keys: () => Array.from(map.keys()),
  }
}

describe('conversation-links store', () => {
  beforeEach(() => {
    initConversationLinks(makeKv())
  })

  it('adds and finds a link order-independently', () => {
    addPersistedConvLink('conv_b', 'conv_a')
    expect(findConvLink('conv_a', 'conv_b')).not.toBeNull()
    expect(findConvLink('conv_b', 'conv_a')).not.toBeNull()
    // Stored sorted.
    const link = findConvLink('conv_a', 'conv_b')
    expect(link?.convA).toBe('conv_a')
    expect(link?.convB).toBe('conv_b')
  })

  it('is idempotent: re-adding the same pair does not duplicate', () => {
    addPersistedConvLink('conv_a', 'conv_b')
    addPersistedConvLink('conv_a', 'conv_b')
    expect(getConvLinksFor('conv_a')).toHaveLength(1)
  })

  it('removes a link order-independently', () => {
    addPersistedConvLink('conv_a', 'conv_b')
    expect(removePersistedConvLink('conv_b', 'conv_a')).toBe(true)
    expect(findConvLink('conv_a', 'conv_b')).toBeNull()
    expect(removePersistedConvLink('conv_a', 'conv_b')).toBe(false)
  })

  it('lists all links touching a conversation', () => {
    addPersistedConvLink('conv_a', 'conv_b')
    addPersistedConvLink('conv_a', 'conv_c')
    addPersistedConvLink('conv_d', 'conv_e')
    expect(getConvLinksFor('conv_a')).toHaveLength(2)
    expect(getConvLinksFor('conv_d')).toHaveLength(1)
    expect(getConvLinksFor('conv_z')).toHaveLength(0)
  })

  it('touch refreshes lastUsed without erroring on a missing link', () => {
    addPersistedConvLink('conv_a', 'conv_b')
    const before = findConvLink('conv_a', 'conv_b')?.lastUsed ?? 0
    touchConvLink('conv_a', 'conv_b')
    const after = findConvLink('conv_a', 'conv_b')?.lastUsed ?? 0
    expect(after).toBeGreaterThanOrEqual(before)
    // No-op (no throw) for a pair with no row.
    expect(() => touchConvLink('conv_x', 'conv_y')).not.toThrow()
  })

  it('persists across re-init from the same KV (survives restart)', () => {
    const kv = makeKv()
    initConversationLinks(kv)
    addPersistedConvLink('conv_a', 'conv_b')
    // Simulate broker restart: re-init from the same backing store.
    initConversationLinks(kv)
    expect(findConvLink('conv_a', 'conv_b')).not.toBeNull()
  })

  it('evicts links unused for over 90 days on init', () => {
    const kv = makeKv()
    const old = Date.now() - 91 * 24 * 60 * 60 * 1000
    kv.set('conversation-links', [{ convA: 'conv_a', convB: 'conv_b', createdAt: old, lastUsed: old }])
    initConversationLinks(kv)
    expect(findConvLink('conv_a', 'conv_b')).toBeNull()
  })
})
