import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureVacuum } from '../estimate'
import { BYTES_CACHE_FILE } from '../measure-bytes'
import { addConversation, makeVacuumDb, seedMonths, writeBackupSentinel } from './fixture'

/** Fixed 'now' so month eligibility is deterministic rather than a function of
 *  when the suite happens to run. 2026-08-14T00:00:00Z. */
const NOW = Date.UTC(2026, 7, 14)

let root: string
let cacheDir: string
let backupDir: string
let archiveDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vacuum-est-'))
  cacheDir = join(root, 'cache')
  backupDir = join(root, 'backups')
  archiveDir = join(root, 'archives')
  mkdirSync(cacheDir, { recursive: true })
  mkdirSync(backupDir, { recursive: true })
  mkdirSync(archiveDir, { recursive: true })
  makeVacuumDb(cacheDir)
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Fast tier only -- what a dialog open does. Byte figures stay 0. */
function estimate(hotDays = 30) {
  return measureVacuum({ cacheDir, backupDir, archiveDir, hotDays, now: NOW })
}

/** Fast tier plus the expensive byte pass -- what "measure bytes now" does. */
function estimateWithBytes(hotDays = 30) {
  return measureVacuum({ cacheDir, backupDir, archiveDir, hotDays, now: NOW, remeasureBytes: true })
}

describe('month measurement', () => {
  beforeEach(() => {
    seedMonths(cacheDir, [
      { month: '2026-05', rows: 40 },
      { month: '2026-06', rows: 30 },
      { month: '2026-08', rows: 10 },
    ])
    addConversation(cacheDir, '2026-05', 'ended')
    addConversation(cacheDir, '2026-06', 'active')
    addConversation(cacheDir, '2026-08', 'active')
  })

  it('counts rows per UTC month in the fast tier', () => {
    const months = estimate().months
    expect(months.map(m => m.month)).toEqual(['2026-05', '2026-06', '2026-08'])
    expect(months.find(m => m.month === '2026-05')?.rows).toBe(40)
  })

  it('reports bytes only once the byte pass has run', () => {
    expect(estimate().months.every(m => m.contentBytes === 0)).toBe(true)
    expect(estimateWithBytes().months.every(m => m.contentBytes > 0)).toBe(true)
  })

  it('attributes ended rows separately from the delete unit', () => {
    const months = estimate().months
    expect(months.find(m => m.month === '2026-05')?.endedRows).toBe(40)
    expect(months.find(m => m.month === '2026-06')?.endedRows).toBe(0)
  })

  it('marks only fully-aged-out months eligible, never the current one', () => {
    const eligible = estimate(30)
      .months.filter(m => m.eligible)
      .map(m => m.month)
    expect(eligible).toEqual(['2026-05', '2026-06'])
  })

  it('a wider hot window makes fewer months eligible -- this is THE knob', () => {
    expect(
      estimate(90)
        .months.filter(m => m.eligible)
        .map(m => m.month),
    ).toEqual(['2026-05'])
  })

  it('uses octet_length, so multi-byte content is not under-counted', () => {
    // The fixture content carries a snowman (U+2603, 3 bytes in UTF-8). A
    // character count would report fewer bytes than the archive actually holds.
    const may = estimateWithBytes().months.find(m => m.month === '2026-05')
    expect(may && may.contentBytes > may.rows * 100).toBe(true)
  })
})

describe('orphan measurement', () => {
  it('finds rows whose conversation no longer exists', () => {
    seedMonths(cacheDir, [{ month: '2026-06', rows: 25 }])
    // No addConversation -- every row is orphaned.
    const orphans = estimateWithBytes().orphans
    expect(orphans.rows).toBe(25)
    expect(orphans.conversations).toBe(1)
    expect(orphans.contentBytes).toBeGreaterThan(0)
  })

  it('ignores rows whose conversation still exists', () => {
    seedMonths(cacheDir, [{ month: '2026-06', rows: 25 }])
    addConversation(cacheDir, '2026-06', 'ended')
    expect(estimate().orphans.rows).toBe(0)
  })

  it('refuses to sweep orphans inside a month still pending its archive prune', () => {
    // This is the ordering trap from the live database: every row of the
    // already-archived 2026-04 is an orphan. Sweeping it before the month is
    // pruned makes pruneArchivedMonth roll back on the count mismatch.
    seedMonths(cacheDir, [{ month: '2026-06', rows: 20 }])
    const orphans = estimate(30).orphans
    expect(orphans.rows).toBe(20)
    expect(orphans.months).toEqual(['2026-06'])
    expect(orphans.sweepableRows).toBe(0)
    expect(orphans.sweepableBytes).toBe(0)
  })

  it('sweeps orphans once their month is outside the archive candidates', () => {
    seedMonths(cacheDir, [{ month: '2026-08', rows: 20 }])
    const orphans = estimate(30).orphans
    expect(orphans.rows).toBe(20)
    expect(orphans.sweepableRows).toBe(20)
  })
})

describe('redundant index detection', () => {
  beforeEach(() => seedMonths(cacheDir, [{ month: '2026-06', rows: 5 }]))

  it('flags each duplicate exactly once and keeps the canonical name', () => {
    const dupes = estimate().redundantIndexes
    expect(dupes.map(d => d.name)).toEqual(['idx_transcript_session', 'idx_transcript_session_seq'])
    expect(dupes.find(d => d.name === 'idx_transcript_session')?.duplicateOf).toBe('idx_transcript_conversation')
  })

  it('never flags an index with a unique column list', () => {
    expect(estimate().redundantIndexes.map(d => d.name)).not.toContain('idx_transcript_timestamp')
  })

  it('prefers dropping the legacy session name over the canonical one', () => {
    // NAMING covenant: 'conversation' is canonical, 'session' is the dead term.
    for (const dupe of estimate().redundantIndexes) {
      expect(dupe.name).toContain('session')
      expect(dupe.duplicateOf).toContain('conversation')
    }
  })
})

describe('footprint and projection', () => {
  beforeEach(() => {
    seedMonths(cacheDir, [
      { month: '2026-05', rows: 50 },
      { month: '2026-08', rows: 50 },
    ])
    addConversation(cacheDir, '2026-05', 'ended')
    addConversation(cacheDir, '2026-08', 'active')
  })

  it('measures the real file size and separates content from FTS index', () => {
    const { footprint } = estimateWithBytes()
    expect(footprint.fileBytes).toBeGreaterThan(0)
    expect(footprint.totalRows).toBe(100)
    expect(footprint.contentBytes).toBeGreaterThan(0)
    expect(footprint.ftsIndexBytes).toBeGreaterThan(0)
    expect(footprint.otherBytes).toBeGreaterThanOrEqual(0)
  })

  it('never projects a reclaim larger than the database itself', () => {
    const est = estimateWithBytes()
    expect(est.projectedTranscriptBytes).toBeLessThanOrEqual(est.footprint.fileBytes)
    expect(est.projectedDbBytesAfter).toBeGreaterThanOrEqual(0)
  })

  it('projects nothing when no month is eligible', () => {
    const est = measureVacuum({ cacheDir, backupDir, archiveDir, hotDays: 3650, now: NOW, remeasureBytes: true })
    expect(est.months.some(m => m.eligible)).toBe(false)
    expect(est.projectedTranscriptBytes).toBe(0)
  })

  it('plans to flip auto_vacuum to INCREMENTAL while it is still NONE', () => {
    expect(estimate().vacuum.willEnableIncremental).toBe(true)
  })

  it('stamps when it measured, so the panel can show a staleness warning', () => {
    expect(estimate().measuredAt).toBe(new Date(NOW).toISOString())
  })
})

describe('byte provenance -- a stale number must never look live', () => {
  beforeEach(() => {
    seedMonths(cacheDir, [{ month: '2026-05', rows: 20 }])
    addConversation(cacheDir, '2026-05', 'ended')
  })

  it("says 'unmeasured' before any byte pass, rather than implying zero reclaim", () => {
    const est = estimate()
    expect(est.bytes.provenance).toBe('unmeasured')
    expect(est.bytes.measuredAt).toBe('')
    expect(est.projectedTranscriptBytes).toBe(0)
  })

  it("says 'measured' when the byte pass ran during this request", () => {
    const est = estimateWithBytes()
    expect(est.bytes.provenance).toBe('measured')
    expect(est.bytes.ageSeconds).toBe(0)
  })

  it("says 'cached' on a later open, and reports the real age", () => {
    // Byte pass two hours ago...
    measureVacuum({
      cacheDir,
      backupDir,
      archiveDir,
      hotDays: 30,
      now: NOW - 7_200_000,
      remeasureBytes: true,
    })
    // ...then a plain open now.
    const est = estimate()
    expect(est.bytes.provenance).toBe('cached')
    expect(est.bytes.ageSeconds).toBe(7200)
    expect(est.months.find(m => m.month === '2026-05')?.contentBytes).toBeGreaterThan(0)
  })

  it('keeps row counts exact and fresh even when bytes are stale', () => {
    measureVacuum({ cacheDir, backupDir, archiveDir, hotDays: 30, now: NOW - 7_200_000, remeasureBytes: true })
    seedMonths(cacheDir, [{ month: '2026-06', rows: 7 }])

    const est = estimate()
    // The new month appears immediately with an exact count...
    expect(est.months.find(m => m.month === '2026-06')?.rows).toBe(7)
    // ...but honestly reports 0 bytes, because the cache predates it.
    expect(est.months.find(m => m.month === '2026-06')?.contentBytes).toBe(0)
    expect(est.bytes.provenance).toBe('cached')
  })

  it('ignores a corrupt cache rather than reading zeroes out of it', () => {
    estimateWithBytes()
    writeFileSync(join(cacheDir, BYTES_CACHE_FILE), '{ this is not json')
    expect(estimate().bytes.provenance).toBe('unmeasured')
  })
})

describe('the backup gate is reported, never silently skipped', () => {
  beforeEach(() => seedMonths(cacheDir, [{ month: '2026-05', rows: 5 }]))

  it('refuses with a literal reason when no backup has ever succeeded', () => {
    const { gate } = estimate()
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('has a backup ever succeeded')
  })

  it('passes on a fresh verified backup and reports its age', () => {
    writeBackupSentinel(backupDir, { ageMinutes: 10, now: NOW })
    const { gate } = estimate()
    expect(gate.ok).toBe(true)
    expect(gate.backupAgeMinutes).toBe(10)
    expect(gate.backupArchive).toBe('backup-fixture.tar.zst')
  })

  it('refuses on a stale backup and says how stale', () => {
    writeBackupSentinel(backupDir, { ageMinutes: 600, now: NOW })
    const { gate } = estimate()
    expect(gate.ok).toBe(false)
    expect(gate.reason).toContain('600m old')
  })
})

describe('file sweeps', () => {
  it('matches only files older than the threshold', () => {
    const sotu = join(cacheDir, 'sotu')
    mkdirSync(sotu, { recursive: true })
    writeFileSync(join(sotu, 'old.json'), 'x'.repeat(500))
    writeFileSync(join(sotu, 'new.json'), 'y'.repeat(100))
    const oldSeconds = (NOW - 60 * 86_400_000) / 1000
    utimesSync(join(sotu, 'old.json'), oldSeconds, oldSeconds)
    utimesSync(join(sotu, 'new.json'), NOW / 1000, NOW / 1000)

    const sweep = estimate().fileSweeps.find(f => f.key === 'sotu')
    expect(sweep?.files).toBe(2)
    expect(sweep?.matchedFiles).toBe(1)
    expect(sweep?.matchedBytes).toBe(500)
  })

  it('reports a missing directory as unconfigured rather than as zero bytes to reclaim', () => {
    const sweep = estimate().fileSweeps.find(f => f.key === 'crashes')
    expect(sweep?.configured).toBe(false)
    expect(sweep?.matchedBytes).toBe(0)
  })
})
