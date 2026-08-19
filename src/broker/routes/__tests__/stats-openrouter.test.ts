/**
 * Tests for /api/stats/openrouter -- the by-feature OpenRouter spend read.
 *
 * Spend is admin-only, exactly like its neighbours in this router. The window
 * options stop at 30d because that is the store's retention bound.
 */

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Hono } from 'hono'
import { setRclaudeSecret } from '../../auth-routes'
import { type ConversationStore, createConversationStore } from '../../conversation-store'
import { closeOpenRouterSpendStore, initOpenRouterSpendStore, recordSpend } from '../../openrouter-spend-store'
import { createMemoryDriver } from '../../store/memory/driver'
import type { StoreDriver } from '../../store/types'
import { createRouteHelpers, type RouteHelpers } from '../shared'
import { createStatsRouter } from '../stats'

const TEST_SECRET = 'test-secret-stats-openrouter-42'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${TEST_SECRET}` }
}

let app: Hono
let store: StoreDriver
let conversationStore: ConversationStore
let helpers: RouteHelpers
let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'or-spend-route-'))
  initOpenRouterSpendStore(dir)
  store = createMemoryDriver()
  store.init()
  conversationStore = createConversationStore({ store, enablePersistence: false })
  setRclaudeSecret(TEST_SECRET)
  helpers = createRouteHelpers(TEST_SECRET)

  app = new Hono()
  app.route('/', createStatsRouter(conversationStore, store, helpers, Date.now()))
})

afterEach(() => {
  closeOpenRouterSpendStore()
  rmSync(dir, { recursive: true, force: true })
})

function spend(feature: string, model: string, costUsd: number): void {
  recordSpend({
    feature,
    model,
    ms: 300,
    ok: true,
    usage: {
      inputTokens: 10,
      outputTokens: 5,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd,
      costSource: 'openrouter',
    },
  })
}

interface RollupBody {
  period: string
  feature?: string
  totals: { calls: number; costUsd: number; failedCalls: number }
  byFeature: Array<{ key: string; costUsd: number }>
  byModel: Array<{ key: string; costUsd: number }>
}

describe('GET /api/stats/openrouter', () => {
  it('rejects without admin auth -- spend is not public', async () => {
    const res = await app.request('/api/stats/openrouter')
    expect(res.status).toBe(403)
  })

  it('rejects a period the retention bound cannot honour', async () => {
    const res = await app.request('/api/stats/openrouter?period=90d', { headers: authHeaders() })
    expect(res.status).toBe(400)
  })

  it('returns empty rollups when nothing was spent', async () => {
    const res = await app.request('/api/stats/openrouter', { headers: authHeaders() })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RollupBody
    expect(body.period).toBe('24h')
    expect(body.byFeature).toEqual([])
    expect(body.totals).toMatchObject({ calls: 0, costUsd: 0 })
  })

  it('returns real by-feature and by-model numbers', async () => {
    spend('desk-agent', 'anthropic/claude-haiku-4-5', 0.01)
    spend('desk-agent', 'anthropic/claude-opus-4', 0.4)
    spend('recap-period', 'anthropic/claude-haiku-4-5', 0.05)
    recordSpend({ feature: 'voice-refiner', model: 'google/gemma-4-31b', ms: 30_000, ok: false, error: 'TimeoutError' })

    const res = await app.request('/api/stats/openrouter?period=7d', { headers: authHeaders() })
    const body = (await res.json()) as RollupBody
    expect(body.period).toBe('7d')
    expect(body.byFeature.map(g => g.key)).toEqual(['desk-agent', 'recap-period', 'voice-refiner'])
    expect(body.byFeature[0].costUsd).toBeCloseTo(0.41)
    expect(body.totals.calls).toBe(4)
    expect(body.totals.failedCalls).toBe(1)
    expect(body.totals.costUsd).toBeCloseTo(0.46)
  })

  it('scopes the by-model breakdown with ?feature=', async () => {
    spend('desk-agent', 'anthropic/claude-haiku-4-5', 0.01)
    spend('recap-period', 'anthropic/claude-opus-4', 0.4)

    const res = await app.request('/api/stats/openrouter?feature=desk-agent', { headers: authHeaders() })
    const body = (await res.json()) as RollupBody
    expect(body.feature).toBe('desk-agent')
    expect(body.byModel.map(g => g.key)).toEqual(['anthropic/claude-haiku-4-5'])
    expect(body.byFeature).toHaveLength(2)
  })
})
