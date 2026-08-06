import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { BUILD_VERSION } from '../../shared/version'
import { compressDir, pickCompressor } from './compress'
import { sha256File } from './hash'
import { sweepStaleTempDirs } from './list'
import { pruneBackups } from './prune'
import { writeSuccessSentinel } from './sentinel'
import { type ReclaimMode, snapshotBlobs, snapshotDatabases, snapshotFlatFiles } from './snapshot'
import { BACKUP_PREFIX, type BackupCreateOptions, type BackupManifest } from './types'

function formatTimestamp(date: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return [
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}`,
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`,
  ].join('-')
}

function buildManifest(now: Date, files: BackupManifest['files']): BackupManifest {
  return {
    timestamp: now.toISOString(),
    hostname: hostname(),
    version: {
      gitHash: BUILD_VERSION.gitHash,
      gitHashShort: BUILD_VERSION.gitHashShort,
      branch: BUILD_VERSION.branch,
      buildTime: BUILD_VERSION.buildTime,
      dirty: BUILD_VERSION.dirty,
    },
    files,
    durationMs: 0,
  }
}

export async function createBackup(opts: BackupCreateOptions): Promise<string> {
  const { cacheDir, destDir, includeBlobs = false, retainHours = 24, retainDays = 7 } = opts
  const reclaim = (process.env.CLAUDWERK_BACKUP_RECLAIM as ReclaimMode) || 'zero'
  const compressor = pickCompressor(opts.compressor)

  const start = Date.now()
  const now = new Date()
  const tag = formatTimestamp(now)
  const tmpDir = join(destDir, `_tmp_backup_${tag}`)
  const archiveName = `${BACKUP_PREFIX}${tag}${compressor.ext}`
  const archivePath = join(destDir, archiveName)

  mkdirSync(destDir, { recursive: true })
  sweepStaleTempDirs(destDir)
  mkdirSync(tmpDir, { recursive: true })

  try {
    const manifestFiles = [
      ...snapshotDatabases(cacheDir, tmpDir, reclaim),
      ...snapshotFlatFiles(cacheDir, tmpDir),
      ...(includeBlobs ? await snapshotBlobs(cacheDir, tmpDir) : []),
    ]

    const manifest = buildManifest(now, manifestFiles)
    await Bun.write(join(tmpDir, 'manifest.json'), JSON.stringify(manifest, null, 2))

    console.log(`Compressing (${compressor.compressArgv.join(' ')})...`)
    await compressDir(tmpDir, archivePath, compressor)

    manifest.durationMs = Date.now() - start

    const archiveSize = statSync(archivePath).size
    const totalData = manifestFiles.reduce((s, f) => s + f.size, 0)
    const ratio = totalData > 0 ? ((1 - archiveSize / totalData) * 100).toFixed(1) : '0'
    const sha256 = sha256File(archivePath)

    console.log(`\nBackup complete: ${archiveName}`)
    console.log(`  Archive:  ${(archiveSize / 1024 / 1024).toFixed(1)} MB (${ratio}% compression)`)
    console.log(`  Source:   ${(totalData / 1024 / 1024).toFixed(1)} MB`)
    console.log(`  Duration: ${manifest.durationMs}ms`)
    console.log(`  Reclaim:  ${reclaim}`)
    console.log(`  Broker:   ${BUILD_VERSION.gitHashShort} (${BUILD_VERSION.branch})`)

    // Sentinel is written only after the archive exists and has been hashed --
    // it is the maintenance job's proof that a rollback point is on disk.
    writeSuccessSentinel(destDir, {
      timestamp: now.toISOString(),
      epochMs: now.getTime(),
      archive: archiveName,
      sizeBytes: archiveSize,
      sha256,
      durationMs: manifest.durationMs,
      brokerVersion: BUILD_VERSION.gitHashShort,
    })

    pruneBackups(destDir, retainHours, retainDays)

    return archivePath
  } finally {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true })
  }
}
