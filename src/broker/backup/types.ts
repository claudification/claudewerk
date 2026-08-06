export const DATABASES = ['store.db', 'analytics.db', 'projects.db'] as const
export const FLAT_FILES = ['auth.json', 'auth.secret', 'sentinel-registry.json'] as const

export const BACKUP_PREFIX = 'backup-'

/** Matches both compressors. `.tar.gz` is the legacy format and MUST stay
 *  recognised forever -- archives written before the zstd cutover are still the
 *  only copy of that hour, and `backup-monitor.sh` globs the same shapes. */
export const BACKUP_PATTERN = /^backup-(\d{8}-\d{6})\.tar\.(gz|zst)$/

export const SUCCESS_SENTINEL = '.last-success.json'

export interface BackupManifest {
  timestamp: string
  hostname: string
  version: {
    gitHash: string
    gitHashShort: string
    branch: string
    buildTime: string
    dirty: boolean
  }
  files: Array<{
    path: string
    size: number
    sha256: string
  }>
  durationMs: number
}

export interface BackupInfo {
  filename: string
  timestamp: Date
  size: number
}

export interface BackupCreateOptions {
  cacheDir: string
  destDir: string
  includeBlobs?: boolean
  retainHours?: number
  retainDays?: number
  /** Force a specific compressor. Defaults to zstd when available, else gzip. */
  compressor?: string
}

/** Written by a successful `backup create`; read by the maintenance gate.
 *  Maintenance refuses to touch the database unless one of these is recent and
 *  its archive still verifies -- the backup IS the rollback. */
export interface BackupSuccessSentinel {
  timestamp: string
  epochMs: number
  archive: string
  sizeBytes: number
  sha256: string
  durationMs: number
  brokerVersion: string
}
