/**
 * File Reaper - mtime-based blob eviction
 * Deletes uploaded files older than maxAgeDays (default 7).
 * Runs on startup + daily interval.
 */

import { readdirSync, readFileSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

const DAY_MS = 24 * 60 * 60 * 1000

function reapExpiredFiles(blobDir: string, maxAgeDays = 7): number {
  const cutoff = Date.now() - maxAgeDays * DAY_MS
  let evicted = 0
  try {
    for (const file of readdirSync(blobDir)) {
      if (!file.endsWith('.meta')) continue
      try {
        const metaPath = join(blobDir, file)
        const meta = JSON.parse(readFileSync(metaPath, 'utf8'))
        // Use createdAt from meta, fall back to file mtime
        const age = meta.createdAt ?? statSync(metaPath).mtimeMs
        if (age < cutoff) {
          const hash = file.replace('.meta', '')
          try {
            unlinkSync(join(blobDir, hash))
          } catch {}
          try {
            unlinkSync(metaPath)
          } catch {}
          evicted++
        }
      } catch {
        /* corrupt meta, skip */
      }
    }
  } catch {
    /* dir gone */
  }
  return evicted
}

/** Start the reaper: runs immediately, then every 24h */
export function startFileReaper(blobDir: string, maxAgeDays = 7): void {
  function run() {
    const count = reapExpiredFiles(blobDir, maxAgeDays)
    if (count > 0) console.log(`[reaper] Evicted ${count} expired blobs (>${maxAgeDays}d)`)
  }
  run()
  setInterval(run, DAY_MS)
}
