/**
 * `GET /api/stats/activity-matrix` -- the contribution grid's one request.
 *
 * ONE request, FIVE metrics. The pane's hover shows the hovered day's number on
 * every metric at once, so five endpoints would mean five requests per hover for
 * data the same three tables already yielded in one pass.
 *
 * `tz` IS REQUIRED and there is deliberately no fallback. The broker container
 * runs in UTC, so a defaulted zone would bucket every Bangkok evening onto the
 * next day's square -- and the result would look exactly like data rather than
 * like a bug. A zone this runtime does not know is a 400, never a silent UTC.
 *
 * ADMIN-ONLY, like every other route under `/api/stats/`: the USD fold is fleet
 * spend, and spend is not public. A per-project variant would need a visibility
 * filter on all three sources, including the disclosure-oracle care
 * `countVisibleCommits` documents, and is not this card.
 *
 * READ-ONLY. Every number is derived at request time from tables that already
 * exist; nothing here writes, migrates, or creates schema.
 *
 * Mounted by `createStatsRouter` rather than declared inside it -- that function
 * was already past every unit-size threshold the repo lints for.
 */

import { Hono } from 'hono'
import { ACTIVITY_DEFAULT_DAYS, ACTIVITY_MAX_DAYS } from '../../shared/activity-matrix'
import { isValidTimeZone } from '../../shared/cron-time'
import { buildActivityMatrix } from '../activity-matrix/matrix'
import { brokerActivitySources } from '../activity-matrix/sources'
import type { StoreDriver } from '../store/types'
import type { RouteHelpers } from './shared'

/** Query-string -> day count, or the message explaining why it will not serve. */
function parseDays(raw: string | undefined): { days: number } | { error: string } {
  if (!raw) return { days: ACTIVITY_DEFAULT_DAYS }
  const n = Number(raw)
  if (!Number.isFinite(n) || n < 1 || n > ACTIVITY_MAX_DAYS) {
    return { error: `Invalid days. Use 1..${ACTIVITY_MAX_DAYS}` }
  }
  return { days: Math.floor(n) }
}

export function createActivityMatrixRouter(store: StoreDriver, helpers: RouteHelpers): Hono {
  const app = new Hono()

  app.get('/api/stats/activity-matrix', c => {
    if (!helpers.httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin only' }, 403)

    const tz = c.req.query('tz') || ''
    if (!tz) return c.json({ error: 'Missing required parameter: tz (IANA timezone)' }, 400)
    if (!isValidTimeZone(tz)) return c.json({ error: `Unknown IANA timezone: ${tz}` }, 400)

    const days = parseDays(c.req.query('days'))
    if ('error' in days) return c.json({ error: days.error }, 400)

    return c.json(buildActivityMatrix(brokerActivitySources(store), { tz, days: days.days }))
  })

  return app
}
