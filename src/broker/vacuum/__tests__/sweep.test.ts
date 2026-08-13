import { Database } from 'bun:sqlite'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { measureVacuum } from '../estimate'
import { dropRedundantIndexes, sweepFiles } from '../sweep'
import { addConversation, makeVacuumDb, seedMonths } from './fixture'

const NOW = Date.UTC(2026, 7, 14)

let root: string
let cacheDir: string
let backupDir: string
let archiveDir: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'vacuum-sweep-'))
  cacheDir = join(root, 'cache')
  backupDir = join(root, 'backups')
  archiveDir = join(root, 'archives')
  for (const d of [cacheDir, backupDir, archiveDir]) mkdirSync(d, { recursive: true })
  makeVacuumDb(cacheDir)
  seedMonths(cacheDir, [{ month: '2026-05', rows: 10 }])
  addConversation(cacheDir, '2026-05', 'ended')
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function estimate() {
  return measureVacuum({ cacheDir, backupDir, archiveDir, hotDays: 30, now: NOW })
}

function indexNames(): string[] {
  const db = new Database(join(cacheDir, 'store.db'), { strict: true, readonly: true })
  try {
    return (
      db
        .query(`SELECT name FROM sqlite_master WHERE type='index' AND sql IS NOT NULL ORDER BY name`)
        .all() as Array<{ name: string }>
    ).map(r => r.name)
  } finally {
    db.close()
  }
}

describe('dropping redundant indexes', () => {
  it('changes nothing without confirm, and says what it would do', () => {
    const before = indexNames()
    const outcomes = dropRedundantIndexes(cacheDir, estimate().redundantIndexes, false)

    expect(outcomes.every(o => !o.applied)).toBe(true)
    expect(outcomes[0].detail).toContain('dry run')
    expect(indexNames()).toEqual(before)
  })

  it('drops only the duplicates, never the survivor', () => {
    dropRedundantIndexes(cacheDir, estimate().redundantIndexes, true)
    const after = indexNames()

    expect(after).not.toContain('idx_transcript_session')
    expect(after).not.toContain('idx_transcript_session_seq')
    // The canonical names and the genuinely-unique index all survive.
    expect(after).toContain('idx_transcript_conversation')
    expect(after).toContain('idx_transcript_conversation_seq')
    expect(after).toContain('idx_transcript_timestamp')
  })

  it('records the exact CREATE INDEX needed to undo each drop', () => {
    const outcomes = dropRedundantIndexes(cacheDir, estimate().redundantIndexes, true)
    const undo = outcomes.find(o => o.target === 'idx_transcript_session')?.detail
    expect(undo).toContain('CREATE INDEX idx_transcript_session ON transcript_entries(conversation_id)')
  })

  it('refuses to drop an index whose survivor has vanished since the estimate', () => {
    // The estimate is minutes old by the time a user confirms. If the index it
    // planned to keep is gone, dropping the "duplicate" would leave the column
    // unindexed -- a silent, permanent query regression.
    const stale = estimate().redundantIndexes
    const db = new Database(join(cacheDir, 'store.db'), { strict: true })
    db.run('DROP INDEX idx_transcript_conversation')
    db.close()

    const outcomes = dropRedundantIndexes(cacheDir, stale, true)
    const skipped = outcomes.find(o => o.target === 'idx_transcript_session')
    expect(skipped?.applied).toBe(false)
    expect(skipped?.detail).toContain('no longer redundant')
    expect(indexNames()).toContain('idx_transcript_session')
  })

  it('is a no-op on a database with no duplicates', () => {
    dropRedundantIndexes(cacheDir, estimate().redundantIndexes, true)
    expect(dropRedundantIndexes(cacheDir, estimate().redundantIndexes, true)).toEqual([])
  })
})

describe('file sweeps', () => {
  const OLD = (NOW - 60 * 86_400_000) / 1000
  const NEW = NOW / 1000

  function seedSotu() {
    const dir = join(cacheDir, 'sotu')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'old.json'), 'x'.repeat(400))
    writeFileSync(join(dir, 'new.json'), 'y'.repeat(50))
    utimesSync(join(dir, 'old.json'), OLD, OLD)
    utimesSync(join(dir, 'new.json'), NEW, NEW)
    return dir
  }

  function sotuEstimate() {
    const found = estimate().fileSweeps.find(f => f.key === 'sotu')
    if (!found) throw new Error('sotu sweep missing from estimate')
    return found
  }

  it('deletes nothing without confirm', () => {
    const dir = seedSotu()
    const outcome = sweepFiles({ estimate: sotuEstimate(), days: 30 }, false, NOW)

    expect(outcome.applied).toBe(false)
    expect(outcome.detail).toContain('dry run')
    expect(existsSync(join(dir, 'old.json'))).toBe(true)
  })

  it('deletes only files past the threshold', () => {
    const dir = seedSotu()
    const outcome = sweepFiles({ estimate: sotuEstimate(), days: 30 }, true, NOW)

    expect(outcome.applied).toBe(true)
    expect(outcome.bytesReclaimed).toBe(400)
    expect(existsSync(join(dir, 'old.json'))).toBe(false)
    expect(existsSync(join(dir, 'new.json'))).toBe(true)
  })

  it('spares a file written between the estimate and the confirm', () => {
    // The re-walk at sweep time is the point: a stale path list would delete a
    // file that did not exist when the user read the number.
    const dir = seedSotu()
    const stale = sotuEstimate()
    writeFileSync(join(dir, 'arrived-later.json'), 'z'.repeat(999))
    utimesSync(join(dir, 'arrived-later.json'), NEW, NEW)

    sweepFiles({ estimate: stale, days: 30 }, true, NOW)
    expect(existsSync(join(dir, 'arrived-later.json'))).toBe(true)
  })

  it('reports an unconfigured directory rather than claiming success', () => {
    const crashes = estimate().fileSweeps.find(f => f.key === 'crashes')
    if (!crashes) throw new Error('crashes sweep missing')
    const outcome = sweepFiles({ estimate: crashes, days: 30 }, true, NOW)

    expect(outcome.applied).toBe(false)
    expect(outcome.detail).toContain('not configured')
  })

  it('never follows a symlink out of the swept directory', () => {
    const dir = seedSotu()
    const outside = join(root, 'precious.txt')
    writeFileSync(outside, 'do not delete me')
    utimesSync(outside, OLD, OLD)
    symlinkSync(outside, join(dir, 'link-to-precious'))

    sweepFiles({ estimate: sotuEstimate(), days: 30 }, true, NOW)
    expect(existsSync(outside)).toBe(true)
  })
})
