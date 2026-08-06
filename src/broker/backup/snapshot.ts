import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { openBrokerDatabase } from '../sqlite-open'
import { sha256File } from './hash'
import { type BackupManifest, DATABASES, FLAT_FILES } from './types'

type ManifestFiles = BackupManifest['files']

/** Derived artifacts that are fully rebuildable from base tables. Stripped from
 *  snapshots; recreated by createSchema()'s backfill on next startup. */
const DERIVED_ARTIFACTS: Record<string, { triggers: string[]; tables: string[] }> = {
  'store.db': {
    triggers: ['transcript_fts_ai', 'transcript_fts_ad', 'transcript_fts_au'],
    tables: ['transcript_fts'],
  },
}

/** How to reclaim the pages the dropped FTS index used to occupy.
 *
 *  'vacuum' rewrites the entire file a second time -- correct, but on an 8.8 GB
 *  database that is a second full-size write and read on every hourly run, which
 *  is most of the I/O this backup does.
 *
 *  'zero' turns on secure_delete so SQLite zero-fills the freed pages in place.
 *  The file keeps its size, but a run of zeros costs a compressor essentially
 *  nothing, so the *archive* ends up the same size for a fraction of the I/O.
 *  Default, because the archive is what we store. */
export type ReclaimMode = 'vacuum' | 'zero'

function stripDerivedArtifacts(dbPath: string, dbName: string, reclaim: ReclaimMode = 'zero'): void {
  const spec = DERIVED_ARTIFACTS[dbName]
  if (!spec) return
  const db = openBrokerDatabase(dbPath)
  try {
    // secure_delete must be set BEFORE the drops for the freed pages to be
    // zeroed; setting it afterwards does nothing for already-freed pages.
    if (reclaim === 'zero') db.run('PRAGMA secure_delete = ON')

    // Drop triggers BEFORE the FTS table -- otherwise dropping the table fires
    // the AFTER DELETE trigger row-by-row, which is slow and writes to the FTS
    // shadows we're about to discard anyway.
    for (const t of spec.triggers) db.run(`DROP TRIGGER IF EXISTS ${t}`)
    for (const t of spec.tables) db.run(`DROP TABLE IF EXISTS ${t}`)

    if (reclaim === 'vacuum') db.run('VACUUM')
  } finally {
    db.close()
  }
}

/** VACUUM INTO each database, strip its derived artifacts, and record it. */
export function snapshotDatabases(cacheDir: string, tmpDir: string, reclaim: ReclaimMode): ManifestFiles {
  const files: ManifestFiles = []
  console.log('Backing up databases...')
  for (const dbName of DATABASES) {
    const srcPath = join(cacheDir, dbName)
    if (!existsSync(srcPath)) {
      console.log(`  skip ${dbName} (not found)`)
      continue
    }
    const destPath = join(tmpDir, dbName)
    const db = openBrokerDatabase(srcPath)
    try {
      db.run(`VACUUM INTO '${destPath}'`)
    } finally {
      db.close()
    }

    stripDerivedArtifacts(destPath, dbName, reclaim)

    const size = statSync(destPath).size
    files.push({ path: dbName, size, sha256: sha256File(destPath) })
    console.log(`  ${dbName}: ${(size / 1024 / 1024).toFixed(1)} MB`)
  }
  return files
}

/** Copy the small flat config files verbatim. */
export function snapshotFlatFiles(cacheDir: string, tmpDir: string): ManifestFiles {
  const files: ManifestFiles = []
  console.log('Copying config files...')
  for (const name of FLAT_FILES) {
    const srcPath = join(cacheDir, name)
    if (!existsSync(srcPath)) {
      console.log(`  skip ${name} (not found)`)
      continue
    }
    const destPath = join(tmpDir, name)
    copyFileSync(srcPath, destPath)
    const size = statSync(destPath).size
    files.push({ path: name, size, sha256: sha256File(destPath) })
    console.log(`  ${name}: ${(size / 1024).toFixed(1)} KB`)
  }
  return files
}

/** Opt-in blob copy. Recorded as a single directory entry. */
export async function snapshotBlobs(cacheDir: string, tmpDir: string): Promise<ManifestFiles> {
  const blobDir = join(cacheDir, 'blobs')
  if (!existsSync(blobDir)) return []

  console.log('Copying blobs...')
  const destBlobDir = join(tmpDir, 'blobs')
  mkdirSync(destBlobDir, { recursive: true })
  const cp = Bun.spawn(['cp', '-a', `${blobDir}/.`, destBlobDir], { stdout: 'ignore', stderr: 'ignore' })
  await cp.exited

  let totalSize = 0
  let count = 0
  for (const f of readdirSync(destBlobDir)) {
    const st = statSync(join(destBlobDir, f))
    if (st.isFile()) {
      totalSize += st.size
      count++
    }
  }
  console.log(`  blobs: ${count} files, ${(totalSize / 1024 / 1024).toFixed(1)} MB`)
  return [{ path: 'blobs/', size: totalSize, sha256: '(directory)' }]
}
