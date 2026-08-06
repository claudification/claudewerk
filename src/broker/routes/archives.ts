/**
 * Archive routes -- hot-vs-cold transcript coverage.
 *
 * Read-only and admin-gated. Coverage is global infrastructure state (which
 * months live in the database, which have been archived out), so it is not
 * scoped to any project and must never be visible to a share guest.
 */

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import { archiveCoverage } from '../archive'
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

  return app
}
