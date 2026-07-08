/**
 * Tests for /api/stats/tokens -- the token-flow widget's windowed/bucketed
 * per-message token series. Admin-only. global vs per-profile grouping; window
 * -> bucket mapping; from/to derived from the window.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { Hono } from 'hono'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver, TokenSampleInput } from '../../store/types'
import { createRouteHelpers, type RouteHelpers } from '../shared'
import { createStatsRouter } from '../stats'

const TEST_SECRET = 'test-secret-stats-tokens-42'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers

beforeEach(() => {
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)

  app = new Hono()
  app.route('/', createStatsRouter(conversationStore, store, helpers, Date.now()))
})

function recordSample(overrides: Partial<TokenSampleInput> = {}) {
  store.tokens.recordSample({
    uuid: overrides.uuid ?? crypto.randomUUID(),
    timestamp: overrides.timestamp ?? Date.now(),
    conversationId: overrides.conversationId ?? 'conv-1',
    sentinelId: overrides.sentinelId,
    profile: overrides.profile,
    model: overrides.model ?? 'claude-opus-4',
    inputTokens: overrides.inputTokens ?? 100,
    outputTokens: overrides.outputTokens ?? 200,
    cacheReadTokens: overrides.cacheReadTokens ?? 5000,
    cacheWriteTokens: overrides.cacheWriteTokens ?? 25,
    cacheWrite5mTokens: overrides.cacheWrite5mTokens ?? 25,
    cacheWrite1hTokens: overrides.cacheWrite1hTokens ?? 0,
  })
}

describe('GET /api/stats/tokens', () => {
  it('rejects without admin auth', async () => {
    const res = await app.request('/api/stats/tokens')
    expect(res.status).toBe(403)
  })

  it('rejects an unknown window', async () => {
    const res = await app.request('/api/stats/tokens?window=7y', { headers: authHeaders() })
    expect(res.status).toBe(400)
  })

  it('defaults to the 5m window and returns global buckets', async () => {
    recordSample({ timestamp: Date.now() - 10_000, outputTokens: 50 })
    recordSample({ timestamp: Date.now() - 5_000, outputTokens: 70 })
    const res = await app.request('/api/stats/tokens', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      window: string
      bucketMs: number
      groupBy: string
      buckets: Array<{ outputTokens: number; profile: string }>
    }
    expect(body.window).toBe('5m')
    expect(body.bucketMs).toBe(5_000)
    expect(body.groupBy).toBe('global')
    const totalOut = body.buckets.reduce((s, b) => s + b.outputTokens, 0)
    expect(totalOut).toBe(120)
    expect(body.buckets.every(b => b.profile === '')).toBe(true)
  })

  it('groupBy=profile splits series per (sentinelId, profile)', async () => {
    const t = Date.now() - 10_000
    recordSample({ timestamp: t, sentinelId: 'snt_a', profile: 'work', outputTokens: 10 })
    recordSample({ timestamp: t + 1, sentinelId: 'snt_a', profile: 'personal', outputTokens: 20 })
    const res = await app.request('/api/stats/tokens?window=30m&groupBy=profile', { headers: authHeaders() })
    const body = (await res.json()) as { bucketMs: number; buckets: Array<{ profile: string }> }
    expect(body.bucketMs).toBe(30_000)
    expect(body.buckets.map(b => b.profile).sort()).toEqual(['personal', 'work'])
  })

  it('honors a custom ?bucket override', async () => {
    recordSample({ timestamp: Date.now() - 1_000 })
    const res = await app.request('/api/stats/tokens?window=5m&bucket=1000', { headers: authHeaders() })
    const body = (await res.json()) as { bucketMs: number }
    expect(body.bucketMs).toBe(1_000)
  })

  it('sums the real 5m/1h cache-write split per bucket', async () => {
    const t = Date.now() - 10_000
    recordSample({ timestamp: t, cacheWriteTokens: 100, cacheWrite5mTokens: 100, cacheWrite1hTokens: 0 })
    recordSample({ timestamp: t + 1, cacheWriteTokens: 40, cacheWrite5mTokens: 10, cacheWrite1hTokens: 30 })
    const res = await app.request('/api/stats/tokens', { headers: authHeaders() })
    const body = (await res.json()) as {
      buckets: Array<{ cacheWriteTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number }>
    }
    const sum = (k: 'cacheWriteTokens' | 'cacheWrite5mTokens' | 'cacheWrite1hTokens') =>
      body.buckets.reduce((s, b) => s + b[k], 0)
    expect(sum('cacheWriteTokens')).toBe(140)
    expect(sum('cacheWrite5mTokens')).toBe(110)
    expect(sum('cacheWrite1hTokens')).toBe(30)
    // The split reconciles to the collapsed total -- KNOWN, not guessed.
    expect(sum('cacheWrite5mTokens') + sum('cacheWrite1hTokens')).toBe(sum('cacheWriteTokens'))
  })

  it('?conversationId restricts the series to one conversation', async () => {
    const t = Date.now() - 10_000
    recordSample({ timestamp: t, conversationId: 'conv-a', outputTokens: 11 })
    recordSample({ timestamp: t + 1, conversationId: 'conv-b', outputTokens: 22 })
    const res = await app.request('/api/stats/tokens?conversationId=conv-a', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { buckets: Array<{ outputTokens: number }> }
    expect(body.buckets.reduce((s, b) => s + b.outputTokens, 0)).toBe(11)
  })
})
