/**
 * Stats routes -- /api/stats/*, /api/analytics/*, /api/projects, /api/subscriptions
 */

import { Hono } from 'hono'
import {
  queryModelComparison as queryAnalyticsModels,
  querySummary as queryAnalyticsSummary,
  queryTimeSeries as queryAnalyticsTimeSeries,
} from '../analytics-store'
import { buildConnectionInfoList, closeConnection } from '../connection-registry'
import type { ConversationStore } from '../conversation-store'
import { listProjects } from '../project-store'
import type { StoreDriver } from '../store/types'
import type { RouteHelpers } from './shared'

// Token-flow widget windows -> (lookback, bucket width). Each targets ~60-72
// buckets so the inline sparkline reads well at every zoom level.
const TOKEN_WINDOWS: Record<string, { windowMs: number; bucketMs: number }> = {
  '5m': { windowMs: 5 * 60_000, bucketMs: 5_000 },
  '30m': { windowMs: 30 * 60_000, bucketMs: 30_000 },
  '2h': { windowMs: 2 * 60 * 60_000, bucketMs: 120_000 },
  '5h': { windowMs: 5 * 60 * 60_000, bucketMs: 300_000 },
  '1d': { windowMs: 24 * 60 * 60_000, bucketMs: 1_200_000 },
}

export function createStatsRouter(
  conversationStore: ConversationStore,
  store: StoreDriver,
  helpers: RouteHelpers,
  serverStartTime: number,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // ─── Stats ─────────────────────────────────────────────────────────
  app.get('/api/stats', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const allConversations = conversationStore.getAllConversations()
    let active = 0
    let idle = 0
    let ended = 0
    for (const s of allConversations) {
      if (s.status === 'active') active++
      else if (s.status === 'idle') idle++
      else ended++
    }

    const diag = conversationStore.getSubscriptionsDiag()
    const traffic = conversationStore.getTrafficStats()

    return c.json({
      uptime: Math.round((Date.now() - serverStartTime) / 1000),
      conversations: { total: allConversations.length, active, idle, ended },
      connections: {
        total: diag.summary.totalSubscribers,
        legacy: diag.summary.legacySubscribers,
        v2: diag.summary.v2Subscribers,
      },
      traffic,
      channels: diag.summary.channelCounts,
    })
  })

  app.get('/api/subscriptions', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json(conversationStore.getSubscriptionsDiag())
  })

  // ─── Live connections (Nerd "Conns" tab) ──────────────────────────
  app.get('/api/connections', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json({ connections: buildConnectionInfoList(conversationStore) })
  })

  app.post('/api/connections/:id/close', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const id = c.req.param('id')
    const ok = closeConnection(id)
    if (!ok) return c.json({ error: 'Connection not found' }, 404)
    return c.json({ ok: true })
  })

  // ─── Cost reporting ─────────────────────────────────────────────────

  // Shared query-string -> CostStore filter coercion. Hoisted out of the
  // per-route arrows so they stay below the complexity gate after Phase 5
  // adds sentinelId/profile filters.
  function turnFilterFromQuery(q: Record<string, string>) {
    return {
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      account: q.account || undefined,
      model: q.model || undefined,
      projectUri: q.project || q.cwd || undefined,
      sentinelId: q.sentinelId || undefined,
      profile: q.profile || undefined,
    }
  }

  app.get('/api/stats/turns', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      store.costs.queryTurns({
        ...turnFilterFromQuery(q),
        limit: q.limit ? Number(q.limit) : undefined,
        offset: q.offset ? Number(q.offset) : undefined,
      }),
    )
  })

  app.get('/api/stats/hourly', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    return c.json(
      store.costs.queryHourly({
        ...turnFilterFromQuery(q),
        groupBy: (q.groupBy as 'hour' | 'day') || undefined,
      }),
    )
  })

  app.get('/api/stats/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '24h') as '24h' | '7d' | '30d'
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(store.costs.querySummary(period))
  })

  // Per-(sentinelId, profile) breakdown. Profile names can collide across
  // sentinels (`work@default` vs `work@beast` are different accounts), so the
  // (sentinelId, profile) tuple is the key. Legacy turns predating Phase 5
  // bucket under sentinelId='' / profile='default'.
  //
  // Stores NAMES only -- never configDir or env (Profile-Env Boundary covenant).
  app.get('/api/stats/profiles', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const q = c.req.query()
    const rows = store.costs.queryProfileBreakdown({
      from: q.from ? Number(q.from) : undefined,
      to: q.to ? Number(q.to) : undefined,
      sentinelId: q.sentinelId || undefined,
    })
    return c.json({ profiles: rows })
  })

  // ─── Token flow (live token-spend widget) ──────────────────────────
  // Windowed, bucketed per-message token series. `groupBy=global` (default)
  // returns one aggregate series; `groupBy=profile` returns one series per
  // (sentinelId, profile). Used to seed the widget's rolling buffer on load and
  // to render the 5h/1d views; short windows otherwise ride the live
  // token_sample WS stream. Tokens only -- cost is a render-time multiply.
  app.get('/api/stats/tokens', c => {
    const q = c.req.query()
    // Fleet-wide series is admin-only; a single-conversation series is gated on
    // read access to THAT conversation, so the per-conversation cache-hit chart
    // works for any viewer who can already see the transcript.
    const conversationId = q.conversationId || undefined
    if (conversationId) {
      // Admin sees any conversation; a non-admin needs read access to THIS one.
      if (!httpIsAdmin(c.req.raw)) {
        const project = conversationStore.getConversation(conversationId)?.project
        if (!project || !helpers.httpHasPermission(c.req.raw, 'chat:read', project, conversationId)) {
          return c.json({ error: 'Forbidden' }, 403)
        }
      }
    } else if (!httpIsAdmin(c.req.raw)) {
      return c.json({ error: 'Forbidden: admin only' }, 403)
    }
    const windowKey = q.window || '5m'
    const win = TOKEN_WINDOWS[windowKey]
    if (!win) {
      return c.json({ error: `Invalid window. Use ${Object.keys(TOKEN_WINDOWS).join(', ')}` }, 400)
    }
    const groupBy = q.groupBy === 'profile' ? 'profile' : 'global'
    const bucketMs = q.bucket ? Math.max(1000, Number(q.bucket)) : win.bucketMs
    const to = Date.now()
    const from = to - win.windowMs
    const buckets = store.tokens.queryBuckets({
      from,
      to,
      bucketMs,
      groupBy,
      sentinelId: q.sentinelId || undefined,
      profile: q.profile || undefined,
      conversationId,
    })
    return c.json({ window: windowKey, from, to, bucketMs, groupBy, buckets })
  })

  // ─── Projects ──────────────────────────────────────────────────────

  app.get('/api/projects', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    return c.json({ projects: listProjects() })
  })

  // ─── Analytics ─────────────────────────────────────────────────────

  app.get('/api/analytics/summary', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsSummary(period, project))
  })

  app.get('/api/analytics/timeseries', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d'
    const granularity = (c.req.query('granularity') || 'hour') as 'hour' | 'day'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, or 30d' }, 400)
    }
    return c.json(queryAnalyticsTimeSeries(period, granularity, project))
  })

  app.get('/api/analytics/models', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)
    const period = (c.req.query('period') || '7d') as '24h' | '7d' | '30d' | '90d'
    const project = c.req.query('project') || undefined
    if (!['24h', '7d', '30d', '90d'].includes(period)) {
      return c.json({ error: 'Invalid period. Use 24h, 7d, 30d, or 90d' }, 400)
    }
    return c.json(queryAnalyticsModels(period, project))
  })

  return app
}
