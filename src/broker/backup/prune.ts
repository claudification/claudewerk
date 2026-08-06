import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { listBackups } from './list'
import type { BackupInfo } from './types'

export interface PruneResult {
  kept: string[]
  deleted: string[]
  freedBytes: number
}

/** Local Y-M-D. `parseBackupTimestamp` builds the Date from local components, so
 *  grouping with toISOString() (UTC) silently shifted the daily-keeper boundary
 *  by the host's offset -- in Bangkok (+07) the "one per day" backup was the
 *  newest one before 07:00 local, not the newest of that local day. Keep both
 *  ends of the comparison in the same clock. */
function localDayKey(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/** Decide which archives survive: everything inside the hourly window, plus the
 *  newest archive of each local day inside the daily window. */
export function selectForRetention(
  backups: BackupInfo[],
  retainHours: number,
  retainDays: number,
  now: number,
): { keep: Set<string>; drop: BackupInfo[] } {
  const hourCutoff = now - retainHours * 3600_000
  const dayCutoff = now - retainDays * 86400_000

  const dailyKeepers = new Set<string>()
  const keep = new Set<string>()

  // listBackups is newest-first, so the first archive seen for a day is that
  // day's newest -- the one worth keeping.
  for (const b of backups) {
    const ts = b.timestamp.getTime()
    if (ts >= hourCutoff) {
      keep.add(b.filename)
      continue
    }
    const dayKey = localDayKey(b.timestamp)
    if (ts >= dayCutoff && !dailyKeepers.has(dayKey)) {
      dailyKeepers.add(dayKey)
      keep.add(b.filename)
    }
  }

  return { keep, drop: backups.filter(b => !keep.has(b.filename)) }
}

export function pruneBackups(
  destDir: string,
  retainHours: number,
  retainDays: number,
  opts: { dryRun?: boolean; now?: number } = {},
): PruneResult {
  const backups = listBackups(destDir)
  const now = opts.now ?? Date.now()
  const { keep, drop } = selectForRetention(backups, retainHours, retainDays, now)

  const result: PruneResult = { kept: [...keep], deleted: [], freedBytes: 0 }
  if (drop.length === 0) return result

  const verb = opts.dryRun ? 'would prune' : 'pruning'
  console.log(`\nRetention: keeping ${keep.size}, ${verb} ${drop.length} old backup(s)`)
  for (const b of drop) {
    if (!opts.dryRun) rmSync(join(destDir, b.filename), { force: true })
    result.deleted.push(b.filename)
    result.freedBytes += b.size
    console.log(`  ${opts.dryRun ? 'would delete' : 'deleted'} ${b.filename} (${(b.size / 1024 / 1024).toFixed(1)} MB)`)
  }
  console.log(`  ${opts.dryRun ? 'would free' : 'freed'} ${(result.freedBytes / 1024 / 1024 / 1024).toFixed(2)} GB`)
  return result
}
