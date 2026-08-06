/** Cold transcript archives.
 *
 *  One immutable file per calendar month, written once when that month falls
 *  out of the hot window and never touched again. NDJSON rather than CSV
 *  because `content` is arbitrary text carrying newlines, quotes and embedded
 *  JSON -- CSV quoting would be a correctness minefield and lossy at the edges.
 *  NDJSON also survives schema drift (a new column just shows up in later
 *  months) and stays greppable through `zstdgrep`.
 *
 *  Months are keyed in UTC, deliberately. The host's timezone can change; UTC
 *  cannot, and an archive that silently re-partitions because someone moved
 *  timezone is not an archive. */

export const ARCHIVE_PREFIX = 'transcripts-'
export const ARCHIVE_EXT = '.ndjson.zst'
export const META_EXT = '.meta.json'

export const ARCHIVE_PATTERN = /^transcripts-(\d{4})-(\d{2})\.ndjson\.zst$/

/** Columns exported, in order. Written into the meta so an importer can detect
 *  a schema that drifted since the archive was made. */
export const TRANSCRIPT_COLUMNS = [
  'id',
  'conversation_id',
  'seq',
  'sync_epoch',
  'type',
  'subtype',
  'agent_id',
  'uuid',
  'content',
  'timestamp',
  'ingested_at',
] as const

export interface ArchiveMeta {
  /** `YYYY-MM`, UTC. */
  month: string
  rows: number
  minId: number
  maxId: number
  /** Inclusive epoch-ms bounds of the rows actually written. */
  minTs: number
  maxTs: number
  /** UTC epoch-ms half-open range the export selected on: [rangeStart, rangeEnd). */
  rangeStart: number
  rangeEnd: number
  /** sha256 over the UNCOMPRESSED ndjson byte stream. This is the integrity
   *  anchor -- it is independent of the compressor and its settings. */
  plaintextSha256: string
  plaintextBytes: number
  compressedBytes: number
  columns: string[]
  exportedAt: string
  brokerVersion: string
}

export interface ArchiveFileInfo {
  month: string
  archivePath: string
  metaPath: string
  compressedBytes: number
  meta: ArchiveMeta | null
}

export interface ExportOptions {
  cacheDir: string
  archiveDir: string
  /** `YYYY-MM`, UTC. */
  month: string
  /** Overwrite an existing archive for this month instead of refusing. */
  force?: boolean
  /** zstd level. Cold archives are written once and read rarely, so this leans
   *  harder than the hourly backup's level. */
  level?: number
}

export interface VerifyResult {
  month: string
  ok: boolean
  rows: number
  /** Failure reasons; empty when ok. */
  problems: string[]
  /** Set when verified against the live database as well as against the meta. */
  matchedDatabase?: boolean
}
