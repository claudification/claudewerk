import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { archiveName, metaName, monthOf, monthsBetween } from './month'
import { ARCHIVE_PATTERN, type ArchiveFileInfo } from './types'
import { readMeta } from './verify'

function listArchives(archiveDir: string): ArchiveFileInfo[] {
  if (!existsSync(archiveDir)) return []
  const out: ArchiveFileInfo[] = []
  for (const filename of readdirSync(archiveDir)) {
    const m = filename.match(ARCHIVE_PATTERN)
    if (!m) continue
    const month = `${m[1]}-${m[2]}`
    out.push({
      month,
      archivePath: join(archiveDir, archiveName(month)),
      metaPath: join(archiveDir, metaName(month)),
      compressedBytes: statSync(join(archiveDir, filename)).size,
      meta: readMeta(archiveDir, month),
    })
  }
  return out.sort((a, b) => a.month.localeCompare(b.month))
}

export interface CoverageMonth {
  month: string
  /** Rows still in store.db for this month. */
  hotRows: number
  /** Rows in the cold archive, or null when there is no archive. */
  coldRows: number | null
  archived: boolean
}

export interface Coverage {
  months: CoverageMonth[]
  hotRows: number
  coldRows: number
  /** Months with neither hot rows nor an archive, between the first and last
   *  month we know about -- a hole in the record worth surfacing. */
  gaps: string[]
}

/** Hot-vs-cold map. Answers "why did my search find nothing for March" by
 *  showing which months live in the database and which have been archived out. */
/** Rows still in the hot database, grouped by UTC month. */
function hotRowsByMonth(cacheDir: string): Map<string, number> {
  const out = new Map<string, number>()
  const dbPath = join(cacheDir, 'store.db')
  if (!existsSync(dbPath)) return out

  const db = openBrokerDatabase(dbPath, { readonly: true })
  try {
    const rows = db
      .query(
        `SELECT strftime('%Y-%m', timestamp/1000, 'unixepoch') AS mo, COUNT(*) AS n
         FROM transcript_entries GROUP BY mo`,
      )
      .all() as Array<{ mo: string; n: number }>
    for (const r of rows) if (r.mo) out.set(r.mo, r.n)
  } finally {
    db.close()
  }
  return out
}

export function archiveCoverage(cacheDir: string, archiveDir: string): Coverage {
  const archives = new Map(listArchives(archiveDir).map(a => [a.month, a]))
  const hotByMonth = hotRowsByMonth(cacheDir)

  const known = [...new Set([...hotByMonth.keys(), ...archives.keys()])].sort()
  const span = known.length === 0 ? [] : monthsBetween(monthStartMs(known[0]), monthStartMs(known[known.length - 1]))

  const months: CoverageMonth[] = span.map(month => {
    const archive = archives.get(month)
    return {
      month,
      hotRows: hotByMonth.get(month) ?? 0,
      coldRows: archive?.meta?.rows ?? null,
      archived: Boolean(archive),
    }
  })

  return {
    months,
    hotRows: months.reduce((s, m) => s + m.hotRows, 0),
    coldRows: months.reduce((s, m) => s + (m.coldRows ?? 0), 0),
    // A month with neither hot rows nor an archive is a hole in the record.
    gaps: months.filter(m => m.hotRows === 0 && !m.archived).map(m => m.month),
  }
}

function monthStartMs(month: string): number {
  const [y, m] = month.split('-').map(n => parseInt(n, 10))
  return Date.UTC(y, m - 1, 1)
}

/** Months that are fully older than the hot window and therefore candidates for
 *  archiving. The current month is never a candidate -- it is still being
 *  written to. */
export function monthsToArchive(cacheDir: string, hotDays: number, now = Date.now()): string[] {
  const dbPath = join(cacheDir, 'store.db')
  if (!existsSync(dbPath)) return []
  const cutoff = now - hotDays * 86400_000
  const currentMonth = monthOf(now)

  const db = openBrokerDatabase(dbPath, { readonly: true })
  try {
    const rows = db
      .query(
        `SELECT strftime('%Y-%m', timestamp/1000, 'unixepoch') AS mo, MAX(timestamp) AS maxTs
         FROM transcript_entries GROUP BY mo ORDER BY mo`,
      )
      .all() as Array<{ mo: string; maxTs: number }>
    // A month qualifies only when its NEWEST row is past the cutoff, so a month
    // straddling the boundary is left alone until it has fully aged out.
    return rows.filter(r => r.mo && r.mo !== currentMonth && r.maxTs < cutoff).map(r => r.mo)
  } finally {
    db.close()
  }
}
