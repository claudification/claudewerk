/**
 * Archive routes -- hot-vs-cold transcript coverage.
 *
 * Read-only and admin-gated. Coverage is global infrastructure state (which
 * months live in the database, which have been archived out), so it is not
 * scoped to any project and must never be visible to a share guest.
 */

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { archiveCoverage, planArchiveSearch, searchArchives } from '../archive'
import type { RouteHelpers } from './shared'

/** Mirrors the CLI default. Kept here rather than imported from cli/shared so a
 *  route never pulls the CLI's process.exit-happy helpers into the server. */
const ARCHIVE_DIR = existsSync('/data/archives') ? '/data/archives' : ''

export function createArchivesRouter(helpers: RouteHelpers, cacheDir: string): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()

  // No cacheDir means no database to report on (embedded/dev boot).
  const enabled = Boolean(cacheDir) && Boolean(ARCHIVE_DIR)

  app.get('/api/archives/coverage', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) {
      return c.json({ configured: false, months: [], hotRows: 0, coldRows: 0, gaps: [] })
    }
    const coverage = archiveCoverage(cacheDir, ARCHIVE_DIR)
    return c.json({ configured: true, archiveDir: ARCHIVE_DIR, ...coverage })
  })

  /** What a search would cost. Cheap (reads the metas), and the only honest way
   *  to offer the expensive one in a UI. */
  app.get('/api/archives/search/plan', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ configured: false, months: [] })
    const month = c.req.query('month')
    return c.json({ configured: true, ...planArchiveSearch(ARCHIVE_DIR, month ? [month] : undefined) })
  })

  /** SLOW. Decompresses and scans whole months; a request can legitimately run
   *  for minutes. `maxSeconds` is clamped so one request cannot pin a core
   *  forever, and the response always carries what was skipped. */
  app.get('/api/archives/search', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ error: 'Cold archives are not configured on this broker' }, 501)

    const query = c.req.query('q')
    if (!query) return c.json({ error: 'q is required' }, 400)
    const month = c.req.query('month')
    const conversationId = c.req.query('conversation')
    const types = c.req.query('types')?.split(',').filter(Boolean)

    const result = await searchArchives({
      archiveDir: ARCHIVE_DIR,
      query,
      regex: c.req.query('regex') === '1',
      caseSensitive: c.req.query('caseSensitive') === '1',
      limit: clampInt(c.req.query('limit'), 50, 1, 500),
      maxSeconds: clampInt(c.req.query('maxSeconds'), 60, 1, 600),
      ...(month && { months: [month] }),
      ...(conversationId && { conversationId }),
      ...(types?.length && { types }),
    })
    return c.json(result)
  })

  return app
}

function clampInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = raw ? parseInt(raw, 10) : Number.NaN
  return Number.isNaN(n) ? fallback : Math.min(max, Math.max(min, n))
}
