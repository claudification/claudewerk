import { expect, test } from 'bun:test'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listBackups } from '../list'
import { pruneBackups, selectForRetention } from '../prune'
import type { BackupInfo } from '../types'

function info(filename: string, ts: Date, size = 1024): BackupInfo {
  return { filename, timestamp: ts, size }
}

/** listBackups yields newest-first; selectForRetention relies on that ordering
 *  to pick each day's newest as its keeper. */
function newestFirst(items: BackupInfo[]): BackupInfo[] {
  return [...items].sort((a, b) => b.timestamp.getTime() - a.timestamp.getTime())
}

const HOUR = 3600_000
const DAY = 86400_000

test('keeps everything inside the hourly window', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const backups = newestFirst([
    info('backup-20260615-110000.tar.zst', new Date(now - 1 * HOUR)),
    info('backup-20260615-100000.tar.zst', new Date(now - 2 * HOUR)),
    info('backup-20260614-130000.tar.zst', new Date(now - 23 * HOUR)),
  ])
  const { keep, drop } = selectForRetention(backups, 24, 7, now)
  expect(keep.size).toBe(3)
  expect(drop).toHaveLength(0)
})

test('keeps exactly one archive per day in the daily window', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  // Three archives on 2026-06-12, all outside the 24h window.
  const backups = newestFirst([
    info('backup-20260612-230000.tar.zst', new Date(2026, 5, 12, 23, 0, 0)),
    info('backup-20260612-120000.tar.zst', new Date(2026, 5, 12, 12, 0, 0)),
    info('backup-20260612-010000.tar.zst', new Date(2026, 5, 12, 1, 0, 0)),
  ])
  const { keep, drop } = selectForRetention(backups, 24, 7, now)
  expect([...keep]).toEqual(['backup-20260612-230000.tar.zst'])
  expect(drop).toHaveLength(2)
})

test('drops archives older than the daily window entirely', () => {
  const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
  const backups = newestFirst([
    info('backup-20260601-120000.tar.zst', new Date(now - 14 * DAY)),
    info('backup-20260614-120000.tar.zst', new Date(now - 1 * DAY)),
  ])
  const { keep, drop } = selectForRetention(backups, 24, 7, now)
  expect(drop.map(d => d.filename)).toEqual(['backup-20260601-120000.tar.zst'])
  expect(keep.has('backup-20260614-120000.tar.zst')).toBe(true)
})

// REGRESSION -- the daily keeper used to be grouped with toISOString(), i.e. by
// UTC day, while parseBackupTimestamp builds the Date from LOCAL components.
// On a host east of UTC that split a single local day across two UTC days, so
// "one per day" silently kept two. Bangkok (+07) is exactly where this bites.
test('groups daily keepers by LOCAL day, not UTC day', () => {
  // Pin the zone rather than depending on the ambient one: under TZ=UTC the two
  // groupings are identical and the test would prove nothing. Bangkok is the
  // zone this actually ran in when the bug was found.
  const previousTz = process.env.TZ
  process.env.TZ = 'Asia/Bangkok'
  try {
    // Same LOCAL day, straddling the UTC midnight that +07 pushes into the
    // middle of it.
    const early = new Date(2026, 5, 12, 1, 0, 0)
    const late = new Date(2026, 5, 12, 23, 0, 0)
    expect(early.toISOString().slice(0, 10)).toBe('2026-06-11')
    expect(late.toISOString().slice(0, 10)).toBe('2026-06-12')

    const now = new Date(2026, 5, 15, 12, 0, 0).getTime()
    const backups = newestFirst([
      info('backup-20260612-230000.tar.zst', late),
      info('backup-20260612-010000.tar.zst', early),
    ])

    const { keep } = selectForRetention(backups, 24, 7, now)
    // The old UTC-keyed grouping saw two distinct days here and kept BOTH.
    expect(keep.size).toBe(1)
    expect(keep.has('backup-20260612-230000.tar.zst')).toBe(true)
  } finally {
    if (previousTz === undefined) delete process.env.TZ
    else process.env.TZ = previousTz
  }
})

test('prune recognises and removes both .tar.gz and .tar.zst', () => {
  const d = mkdtempSync(join(tmpdir(), 'prune-ext-'))
  try {
    // Well outside any retention window, so both must go.
    writeFileSync(join(d, 'backup-20200101-000000.tar.gz'), 'old gzip')
    writeFileSync(join(d, 'backup-20200102-000000.tar.zst'), 'old zstd')
    writeFileSync(join(d, 'unrelated.txt'), 'leave me')

    expect(listBackups(d)).toHaveLength(2)
    const result = pruneBackups(d, 24, 7)

    expect(result.deleted.sort()).toEqual(['backup-20200101-000000.tar.gz', 'backup-20200102-000000.tar.zst'])
    expect(readdirSync(d)).toEqual(['unrelated.txt'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('dry run reports without deleting', () => {
  const d = mkdtempSync(join(tmpdir(), 'prune-dry-'))
  try {
    writeFileSync(join(d, 'backup-20200101-000000.tar.zst'), 'old')
    const result = pruneBackups(d, 24, 7, { dryRun: true })
    expect(result.deleted).toEqual(['backup-20200101-000000.tar.zst'])
    expect(readdirSync(d)).toEqual(['backup-20200101-000000.tar.zst'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})

test('listBackups sorts by timestamp, not filename', () => {
  const d = mkdtempSync(join(tmpdir(), 'prune-sort-'))
  try {
    // '.gz' sorts before '.zst' as a string, so a filename sort would put the
    // OLDER gzip archive first and hand the daily keeper to the wrong file.
    writeFileSync(join(d, 'backup-20260610-000000.tar.zst'), 'newer')
    writeFileSync(join(d, 'backup-20260609-000000.tar.gz'), 'older')
    const listed = listBackups(d)
    expect(listed.map(b => b.filename)).toEqual(['backup-20260610-000000.tar.zst', 'backup-20260609-000000.tar.gz'])
  } finally {
    rmSync(d, { recursive: true, force: true })
  }
})
