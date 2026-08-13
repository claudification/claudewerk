/**
 * Vacuum routes -- measure, plan, apply.
 *
 * ADMIN ONLY on every route, checked server-side before anything else runs. The
 * panel's own gating is cosmetic; this is the enforcement. Reclaim state is
 * global infrastructure, scoped to no project, and must never be reachable by a
 * share guest.
 *
 * These are a thin policy layer, not a second implementation: apply drives
 * `runVacuum`, which drives the same `runMaintenance` the nightly cron does.
 */

import { existsSync } from 'node:fs'
import { Hono } from 'hono'
import type { VacuumStepMessage } from '../../shared/protocol'
import { getAuthenticatedUser } from '../auth-routes'
import { measureVacuum } from '../vacuum/estimate'
import { measureBytes, writeBytesCache } from '../vacuum/measure-bytes'
import { runVacuum } from '../vacuum/run'
import type { RouteHelpers } from './shared'

/** Mirrors the CLI default; kept local so a route never pulls in the CLI's
 *  process.exit-happy helpers. */
const ARCHIVE_DIR = existsSync('/data/archives') ? '/data/archives' : ''
const BACKUP_DIR = existsSync('/data/backups') ? '/data/backups' : ''

/** 30 is the measured sweet spot on this database (see plan-vacuum.md), but the
 *  bounds are what matter: below 7 days a month can never fully age out, and
 *  above 3650 the feature is inert. */
function clampHotDays(raw: string | undefined, fallback = 30): number {
  const n = raw ? parseInt(raw, 10) : Number.NaN
  return Number.isNaN(n) ? fallback : Math.min(3650, Math.max(7, n))
}

export function createVacuumRouter(
  helpers: RouteHelpers,
  cacheDir: string,
  broadcast: (msg: VacuumStepMessage) => void,
): Hono {
  const { httpIsAdmin } = helpers
  const app = new Hono()
  const enabled = Boolean(cacheDir)

  /** The FAST tier plus whatever byte cache exists -- ~6 s on the live
   *  database. `?bytes=1` additionally runs the ~2 minute byte pass. */
  app.get('/api/vacuum/estimate', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ configured: false }, 501)

    const estimate = measureVacuum({
      cacheDir,
      backupDir: BACKUP_DIR,
      archiveDir: ARCHIVE_DIR,
      hotDays: clampHotDays(c.req.query('hotDays')),
      remeasureBytes: c.req.query('bytes') === '1',
    })
    return c.json({ configured: true, ...estimate })
  })

  /** The expensive byte pass on its own, so the panel can trigger it without
   *  re-running everything and without blocking its own first paint. */
  app.post('/api/vacuum/measure-bytes', c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ error: 'no cache dir' }, 501)

    const report = measureBytes(cacheDir)
    writeBytesCache(cacheDir, report)
    return c.json(report)
  })

  app.post('/api/vacuum/plan', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ error: 'no cache dir' }, 501)
    return c.json(await execute(c.req.raw, await readBody(c), false))
  })

  /** The irreversible one. Still gated three deep behind this point: the backup
   *  gate in runVacuum, the per-month archive verify in runMaintenance, and
   *  pruneArchivedMonth's own transactional row-count rollback. */
  app.post('/api/vacuum/apply', async c => {
    if (!httpIsAdmin(c.req.raw)) return c.json({ error: 'Forbidden: admin required' }, 403)
    if (!enabled) return c.json({ error: 'no cache dir' }, 501)
    if (!ARCHIVE_DIR) {
      return c.json({ error: 'Cold archives are not configured -- refusing to delete unarchivable rows' }, 501)
    }
    return c.json(await execute(c.req.raw, await readBody(c), true))
  })

  function execute(req: Request, body: VacuumRequestBody, confirm: boolean) {
    return runVacuum({
      cacheDir,
      backupDir: BACKUP_DIR,
      archiveDir: ARCHIVE_DIR,
      hotDays: clampHotDays(body.hotDays === undefined ? undefined : String(body.hotDays)),
      confirm,
      initiator: initiatorOf(req),
      runId: crypto.randomUUID().slice(0, 8),
      categories: {
        transcripts: body.transcripts !== false,
        indexes: body.indexes === true,
        files: body.files ?? {},
      },
      emit: broadcast,
    })
  }

  return app
}

interface VacuumRequestBody {
  hotDays?: number
  transcripts?: boolean
  indexes?: boolean
  files?: Record<string, number>
}

async function readBody(c: { req: { json: () => Promise<unknown> } }): Promise<VacuumRequestBody> {
  try {
    return ((await c.req.json()) ?? {}) as VacuumRequestBody
  } catch {
    return {} // an empty body means "defaults", not a 400
  }
}

/** Principal for the audit trail, resolved by the auth module rather than by
 *  re-parsing the cookie here -- a second cookie parser is a second thing to get
 *  wrong. A bearer token is admin-level and anonymous by nature, so it is
 *  recorded as such rather than guessed at. */
function initiatorOf(req: Request): string {
  const user = getAuthenticatedUser(req)
  if (user) return `user:${user}`
  return req.headers.get('authorization') ? 'bearer:admin' : 'unknown'
}
