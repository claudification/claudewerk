import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { BACKUP_PATTERN, type BackupInfo } from './types'

function parseBackupTimestamp(filename: string): Date | null {
  const m = filename.match(BACKUP_PATTERN)
  if (!m) return null
  const d = m[1]
  return new Date(
    parseInt(d.slice(0, 4), 10),
    parseInt(d.slice(4, 6), 10) - 1,
    parseInt(d.slice(6, 8), 10),
    parseInt(d.slice(9, 11), 10),
    parseInt(d.slice(11, 13), 10),
    parseInt(d.slice(13, 15), 10),
  )
}

/** Newest-first. Recognises both `.tar.gz` and `.tar.zst`; sorting on the
 *  timestamp rather than the filename keeps the order stable across the
 *  compressor cutover (`.gz` and `.zst` sort differently as strings). */
export function listBackups(destDir: string): BackupInfo[] {
  if (!existsSync(destDir)) return []

  const results: BackupInfo[] = []
  for (const filename of readdirSync(destDir)) {
    const ts = parseBackupTimestamp(filename)
    if (!ts) continue
    results.push({ filename, timestamp: ts, size: statSync(join(destDir, filename)).size })
  }
  return results.sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

// Reclaim orphaned working dirs from a prior run that was OOM-killed (SIGKILL
// bypasses the finally that would normally rm the temp). Each leaked dir holds
// a full uncompressed db snapshot -- one failed run left 9.2GB behind. Runs
// before a new backup so a crash can never let temp accumulate unbounded.
export function sweepStaleTempDirs(destDir: string): void {
  if (!existsSync(destDir)) return
  for (const name of readdirSync(destDir)) {
    if (!name.startsWith('_tmp_backup_')) continue
    const p = join(destDir, name)
    try {
      if (statSync(p).isDirectory()) rmSync(p, { recursive: true, force: true })
    } catch {
      // best-effort reclaim; a live concurrent run's dir may vanish mid-sweep.
    }
  }
}
