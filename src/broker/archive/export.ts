import { existsSync, mkdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { BUILD_VERSION } from '../../shared/version'
import { openBrokerDatabase } from '../sqlite-open'
import { archiveName, metaName, monthRange } from './month'
import { NdjsonZstdWriter } from './ndjson'
import { type ArchiveMeta, type ExportOptions, TRANSCRIPT_COLUMNS } from './types'

const DEFAULT_LEVEL = 12

interface RowSpan {
  rows: number
  minId: number
  maxId: number
  minTs: number
  maxTs: number
}

/** Stream every row of the range into the writer, tracking the span as we go.
 *  Iterating (rather than .all()) keeps memory flat -- a month is 2.5 GB. */
async function streamRows(
  cacheDir: string,
  range: { start: number; end: number },
  writer: NdjsonZstdWriter,
): Promise<RowSpan> {
  const dbPath = join(cacheDir, 'store.db')
  if (!existsSync(dbPath)) throw new Error(`store.db not found in ${cacheDir}`)

  const db = openBrokerDatabase(dbPath, { readonly: true })
  const span: RowSpan = {
    rows: 0,
    minId: Number.POSITIVE_INFINITY,
    maxId: 0,
    minTs: Number.POSITIVE_INFINITY,
    maxTs: 0,
  }
  try {
    const stmt = db.query(
      `SELECT ${TRANSCRIPT_COLUMNS.join(', ')} FROM transcript_entries
       WHERE timestamp >= $start AND timestamp < $end ORDER BY id`,
    )
    for (const row of stmt.iterate({ start: range.start, end: range.end }) as Iterable<Record<string, unknown>>) {
      await writer.writeRow(row)
      span.rows++
      const id = row.id as number
      const ts = row.timestamp as number
      if (id < span.minId) span.minId = id
      if (id > span.maxId) span.maxId = id
      if (ts < span.minTs) span.minTs = ts
      if (ts > span.maxTs) span.maxTs = ts
      if (span.rows % 50_000 === 0) console.log(`  ${span.rows.toLocaleString()} rows...`)
    }
  } finally {
    db.close()
  }
  return span
}

function logResult(meta: ArchiveMeta, finalPath: string): void {
  const ratio = (meta.plaintextBytes / meta.compressedBytes).toFixed(1)
  console.log(`\nArchived ${meta.month}: ${meta.rows.toLocaleString()} rows`)
  console.log(`  Plain:      ${(meta.plaintextBytes / 1024 / 1024).toFixed(1)} MB`)
  console.log(`  Compressed: ${(meta.compressedBytes / 1024 / 1024).toFixed(1)} MB (${ratio}x)`)
  console.log(`  sha256:     ${meta.plaintextSha256.slice(0, 16)}...`)
  console.log(`  File:       ${finalPath}`)
}

/** Export one UTC month of `transcript_entries` to an immutable NDJSON.zst
 *  archive plus a meta sidecar.
 *
 *  Writes to a `.partial` path and renames only on success, so an interrupted
 *  export can never leave something that looks like a complete archive -- which
 *  matters enormously, because a later retention pass trusts these files enough
 *  to delete the rows they cover. */
export async function exportMonth(opts: ExportOptions): Promise<ArchiveMeta> {
  const { cacheDir, archiveDir, month, force = false, level = DEFAULT_LEVEL } = opts
  const range = monthRange(month)

  mkdirSync(archiveDir, { recursive: true })
  const finalPath = join(archiveDir, archiveName(month))
  const metaPath = join(archiveDir, metaName(month))

  if (existsSync(finalPath) && !force) {
    throw new Error(`Archive already exists: ${finalPath} (pass --force to overwrite)`)
  }

  const partialPath = `${finalPath}.partial`
  const writer = new NdjsonZstdWriter(partialPath, level)

  try {
    console.log(
      `Exporting ${month} (UTC ${new Date(range.start).toISOString()} .. ${new Date(range.end).toISOString()})...`,
    )
    const span = await streamRows(cacheDir, range, writer)
    const { plaintextSha256, plaintextBytes } = await writer.close()

    if (span.rows === 0) throw new Error(`No transcript rows in ${month} -- nothing to archive`)

    renameSync(partialPath, finalPath)

    const meta: ArchiveMeta = {
      month,
      rows: span.rows,
      minId: span.minId,
      maxId: span.maxId,
      minTs: span.minTs,
      maxTs: span.maxTs,
      rangeStart: range.start,
      rangeEnd: range.end,
      plaintextSha256,
      plaintextBytes,
      compressedBytes: statSync(finalPath).size,
      columns: [...TRANSCRIPT_COLUMNS],
      exportedAt: new Date().toISOString(),
      brokerVersion: BUILD_VERSION.gitHashShort,
    }
    writeFileSync(metaPath, `${JSON.stringify(meta, null, 2)}\n`)
    logResult(meta, finalPath)
    return meta
  } catch (err) {
    rmSync(partialPath, { force: true })
    throw err
  }
}
