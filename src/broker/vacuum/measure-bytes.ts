/**
 * The SLOW tier: how many bytes each month of transcript history actually
 * occupies, plus the size of the FTS index.
 *
 * Split out because it is expensive and the cost is not incidental. Measured on
 * the real 10.07 GB store.db:
 *
 *   SUM(octet_length(content)) grouped by month   96 s
 *   SUM(length(block)) over transcript_fts_data   23 s
 *
 * Both have to read the data itself -- 6.27 GB of content and 2.25 GB of index
 * -- so there is no index that makes them cheap and no honest way to shrink
 * them. Sampling would turn a measurement into a guess, which is the one thing
 * a destructive dialog must not do.
 *
 * The answer is therefore to run this rarely, persist it, and be explicit about
 * its age everywhere it surfaces. Byte totals drift slowly (they track months
 * that are already closed), so a result hours old is still a good decision
 * input -- as long as the dialog says how old it is, which `BytesProvenance`
 * exists to make unavoidable.
 *
 * The cache is a JSON sidecar rather than a row in store.db, matching
 * `.last-maintenance.json` and `.last-success.json`, and keeping a read-only
 * estimate path from ever needing a write handle on the database the broker
 * owns.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import type { BytesMeasurement, DbFootprint, MonthEstimate, OrphanEstimate } from './types'

export const BYTES_CACHE_FILE = '.vacuum-bytes.json'

export interface BytesReport {
  measuredAt: string
  epochMs: number
  durationMs: number
  /** Content bytes keyed by UTC month. */
  byMonth: Record<string, number>
  /** Content bytes of rows whose conversation no longer exists, by month. */
  orphanByMonth: Record<string, number>
  totalContentBytes: number
  ftsIndexBytes: number
  /** store.db size when this was taken, so a wildly grown database can be
   *  spotted as a reason to re-measure. */
  fileBytesAtMeasure: number
}

/** Runs the two expensive sums. Takes ~2 minutes on the live database -- always
 *  call it off the request path and report progress. */
export function measureBytes(cacheDir: string, now = Date.now()): BytesReport {
  const started = Date.now()
  const dbPath = join(cacheDir, 'store.db')
  const db = openBrokerDatabase(dbPath, { readonly: true })

  try {
    const byMonth: Record<string, number> = {}
    const orphanByMonth: Record<string, number> = {}

    const monthRows = db
      .query(
        `SELECT strftime('%Y-%m', timestamp/1000, 'unixepoch') AS month,
                SUM(octet_length(content)) AS bytes
         FROM transcript_entries GROUP BY month`,
      )
      .all() as Array<{ month: string; bytes: number | null }>
    for (const r of monthRows) if (r.month) byMonth[r.month] = r.bytes ?? 0

    const orphanRows = db
      .query(
        `SELECT strftime('%Y-%m', t.timestamp/1000, 'unixepoch') AS month,
                SUM(octet_length(t.content)) AS bytes
         FROM transcript_entries t
         WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.id = t.conversation_id)
         GROUP BY month`,
      )
      .all() as Array<{ month: string; bytes: number | null }>
    for (const r of orphanRows) if (r.month) orphanByMonth[r.month] = r.bytes ?? 0

    const fts = db.query(`SELECT SUM(length(block)) AS n FROM transcript_fts_data`).get() as { n: number | null }

    return {
      measuredAt: new Date(now).toISOString(),
      epochMs: now,
      durationMs: Date.now() - started,
      byMonth,
      orphanByMonth,
      totalContentBytes: Object.values(byMonth).reduce((a, b) => a + b, 0),
      ftsIndexBytes: fts.n ?? 0,
      fileBytesAtMeasure: existsSync(dbPath) ? statSync(dbPath).size : 0,
    }
  } finally {
    db.close()
  }
}

export function readBytesCache(cacheDir: string): BytesReport | null {
  const path = join(cacheDir, BYTES_CACHE_FILE)
  if (!existsSync(path)) return null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as BytesReport
    // A hand-edited or half-written sidecar must not silently produce zeroes
    // that read as "nothing to reclaim".
    return typeof parsed?.epochMs === 'number' && parsed.byMonth ? parsed : null
  } catch {
    return null
  }
}

export function writeBytesCache(cacheDir: string, report: BytesReport): void {
  writeFileSync(join(cacheDir, BYTES_CACHE_FILE), `${JSON.stringify(report, null, 2)}\n`)
}

/** Fold a byte report into the fast-tier estimate, in place, and describe how
 *  old the numbers are. With no report every byte figure stays 0 and the
 *  provenance is 'unmeasured' -- the dialog renders that as "not measured yet",
 *  never as "nothing to reclaim". */
export function applyBytes(
  report: BytesReport | null,
  fresh: boolean,
  months: MonthEstimate[],
  orphans: OrphanEstimate,
  footprint: DbFootprint,
  now: number,
): BytesMeasurement {
  if (!report) {
    return { provenance: 'unmeasured', measuredAt: '', ageSeconds: -1, durationMs: 0 }
  }

  for (const month of months) month.contentBytes = report.byMonth[month.month] ?? 0

  orphans.contentBytes = Object.values(report.orphanByMonth).reduce((a, b) => a + b, 0)
  // Reuses measureOrphans' decision verbatim rather than re-deriving it.
  orphans.sweepableBytes = orphans.sweepableMonths.reduce((acc, m) => acc + (report.orphanByMonth[m] ?? 0), 0)

  footprint.contentBytes = report.totalContentBytes
  footprint.ftsIndexBytes = report.ftsIndexBytes
  footprint.otherBytes = Math.max(0, footprint.fileBytes - report.totalContentBytes - report.ftsIndexBytes)

  return {
    provenance: fresh ? 'measured' : 'cached',
    measuredAt: report.measuredAt,
    ageSeconds: Math.max(0, Math.round((now - report.epochMs) / 1000)),
    durationMs: report.durationMs,
  }
}
