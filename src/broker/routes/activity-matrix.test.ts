/**
 * `GET /api/stats/activity-matrix` -- the endpoint contract.
 *
 * Card `werk-activity-matrix-fold`, "Done when": one PERMISSION-GATED endpoint
 * returns all five metrics day-bucketed in a REQUESTED IANA timezone.
 *
 * The two things asserted here that no unit test can reach: the admin gate, and
 * the refusal to invent a timezone. A defaulted `tz` would not fail -- it would
 * quietly return a UTC-bucketed grid that looks exactly like a correct one, so
 * "missing tz is a 400" is the only place that rule can be enforced.
 *
 * Drives the REAL `createStatsRouter` with a memory store; only the two auth
 * helpers are stubbed, because who counts as admin is `auth.ts`'s contract and
 * has its own tests.
 */

import { describe, expect, it } from 'bun:test'
import type { Hono } from 'hono'
import { ACTIVITY_MAX_DAYS } from '../../shared/activity-matrix'
import type { ConversationStore } from '../conversation-store'
import { createMemoryDriver } from '../store/memory/driver'
import type { RouteHelpers } from './shared'
import { createStatsRouter } from './stats'

function router(isAdmin: boolean): Hono {
  const store = createMemoryDriver()
  const now = Date.now()
  store.costs.recordTurn({
    timestamp: now - 3_600_000,
    conversationId: 'c1',
    projectUri: 'claude://default/proj',
    account: 'a@example.com',
    orgId: 'org',
    model: 'claude-opus-5',
    inputTokens: 10,
    outputTokens: 20,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0.5,
    exactCost: true,
  })
  const helpers = { httpIsAdmin: () => isAdmin, httpHasPermission: () => isAdmin } as unknown as RouteHelpers
  return createStatsRouter({} as unknown as ConversationStore, store, helpers, now)
}

async function get(app: Hono, query: string): Promise<Response> {
  return await app.request(`http://localhost:9999/api/stats/activity-matrix${query}`)
}

describe('GET /api/stats/activity-matrix', () => {
  it('is admin-only -- the USD fold is fleet spend', async () => {
    const res = await get(router(false), '?tz=Asia/Bangkok')
    expect(res.status).toBe(403)
  })

  it('refuses to invent a timezone', async () => {
    const res = await get(router(true), '')
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: string }).error).toContain('tz')
  })

  it('refuses a zone this runtime does not know', async () => {
    const res = await get(router(true), '?tz=Mars/Olympus_Mons')
    expect(res.status).toBe(400)
  })

  it('refuses a range it will not serve in one response', async () => {
    expect((await get(router(true), `?tz=UTC&days=${ACTIVITY_MAX_DAYS + 1}`)).status).toBe(400)
    expect((await get(router(true), '?tz=UTC&days=0')).status).toBe(400)
    expect((await get(router(true), '?tz=UTC&days=not-a-number')).status).toBe(400)
  })

  it('returns all five metrics on one shared axis, in the requested zone', async () => {
    const res = await get(router(true), '?tz=Asia/Bangkok&days=30')
    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      tz: string
      defaultMetric: string
      days: Array<{ day: string; dow: number }>
      metrics: Array<{ metric: string; cells: unknown[]; horizon: { kind: string } }>
    }
    expect(body.tz).toBe('Asia/Bangkok')
    expect(body.defaultMetric).toBe('commits')
    expect(body.days).toHaveLength(30)
    expect(body.metrics.map(m => m.metric)).toEqual(['commits', 'cardsClosed', 'turns', 'tokens', 'usd'])
    for (const m of body.metrics) expect(m.cells).toHaveLength(30)
  })

  it('serves the turn folds even with both ledgers uninitialised', async () => {
    // A broker whose commit / card ledgers never opened must still answer. Their
    // horizons say `coverage` with no covered day -- every square grey, which is
    // the truth, not an error.
    const res = await get(router(true), '?tz=UTC&days=7')
    const body = (await res.json()) as {
      metrics: Array<{ metric: string; total: number; horizon: { kind: string; sinceDay?: string } }>
    }
    const turns = body.metrics.find(m => m.metric === 'turns')
    expect(turns?.total).toBe(1)
    const commits = body.metrics.find(m => m.metric === 'commits')
    expect(commits?.horizon).toMatchObject({ kind: 'coverage' })
    expect(commits?.horizon.sinceDay).toBeUndefined()
  })
})
