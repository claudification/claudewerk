/**
 * The two things P2's model can get quietly wrong: which hour band a commit
 * belongs to, and what the 32px delta-t column says.
 *
 * Every timestamp here is built from LOCAL date parts rather than a fixed epoch,
 * because three of the four bands are calendar days and a hard-coded epoch would
 * pass in one timezone and fail in the next.
 */

import type { CommitRow } from '@shared/commit-ledger'
import { describe, expect, it } from 'vitest'
import { commitRiverRows, type RiverProjectLook, riverAge, riverBands, riverBucket } from './commit-river'

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const MIN = 60_000
const HOUR = 60 * MIN

function at(y: number, m: number, d: number, h: number, min = 0): number {
  return new Date(y, m, d, h, min, 0).getTime()
}

const LOOK: (uri: string) => RiverProjectLook = uri => ({
  projectName: uri.split('/').pop() ?? uri,
  projectIcon: 'folder',
  projectColor: '#abcdef',
})

function commit(over: Partial<CommitRow> = {}): CommitRow {
  return {
    id: 1,
    hash: 'a'.repeat(40),
    shortHash: 'aaaaaaa',
    parentHashes: 'b'.repeat(40),
    repoUri: 'claude://default/Users/x/alpha',
    cwdUri: 'claude://default/Users/x/alpha/.claude/worktrees/feature',
    repoName: 'alpha',
    branch: 'feature',
    isWorktree: true,
    conversationId: 'conv-1',
    conversationName: 'blazing-pretzel',
    sentinel: 'default',
    profile: null,
    host: 'studio',
    container: '',
    osUser: 'jonas',
    authorName: 'Jonas Frost',
    authorEmail: 'j@duplo.org',
    subject: 'feat(wall): the river',
    body: '',
    files: [],
    fileCount: 1,
    filesTruncated: false,
    insertions: 12,
    deletions: 3,
    kind: 'normal',
    ccType: 'feat',
    ccScope: 'wall',
    ccBreaking: false,
    origin: 'agent',
    supersededBy: null,
    committedAt: NOW - 10 * MIN,
    ingestedAt: NOW,
    ...over,
  }
}

describe('riverBucket', () => {
  it('puts anything under an hour old in LAST HOUR', () => {
    expect(riverBucket(NOW - MIN, NOW)).toBe('LAST HOUR')
    expect(riverBucket(NOW - 59 * MIN, NOW)).toBe('LAST HOUR')
  })

  it('crosses out of LAST HOUR exactly at the hour', () => {
    expect(riverBucket(NOW - HOUR + 1, NOW)).toBe('LAST HOUR')
    expect(riverBucket(NOW - HOUR, NOW)).toBe('EARLIER TODAY')
  })

  it('files the rest of today under EARLIER TODAY, down to midnight', () => {
    expect(riverBucket(at(2026, 7, 20, 9), NOW)).toBe('EARLIER TODAY')
    expect(riverBucket(at(2026, 7, 20, 0, 0), NOW)).toBe('EARLIER TODAY')
  })

  it('files the previous calendar day under YESTERDAY', () => {
    expect(riverBucket(at(2026, 7, 19, 23, 59), NOW)).toBe('YESTERDAY')
    expect(riverBucket(at(2026, 7, 19, 0, 0), NOW)).toBe('YESTERDAY')
  })

  it('does not pretend anything older is YESTERDAY', () => {
    expect(riverBucket(at(2026, 7, 18, 23, 59), NOW)).toBe('OLDER')
    expect(riverBucket(at(2026, 6, 1, 12), NOW)).toBe('OLDER')
  })

  it('lets the CLOCK beat the calendar across midnight', () => {
    // 00:20, and a commit from 23:50 last night. It is thirty minutes old, and
    // "half an hour ago" is what a human means -- midnight is not a fact about
    // the work.
    const justAfterMidnight = at(2026, 7, 20, 0, 20)
    expect(riverBucket(at(2026, 7, 19, 23, 50), justAfterMidnight)).toBe('LAST HOUR')
  })
})

describe('riverAge', () => {
  it('fits the delta-t column at every scale', () => {
    expect(riverAge(0)).toBe('now')
    expect(riverAge(59_000)).toBe('now')
    expect(riverAge(10 * MIN)).toBe('10m')
    expect(riverAge(59 * MIN)).toBe('59m')
    expect(riverAge(3 * HOUR)).toBe('3h')
    expect(riverAge(23 * HOUR)).toBe('23h')
    expect(riverAge(50 * HOUR)).toBe('2d')
  })
})

describe('commitRiverRows', () => {
  it('carries the full hash, the short one, and the diffstat', () => {
    const [row] = commitRiverRows([commit()], LOOK, NOW)
    expect(row?.hash).toHaveLength(40)
    expect(row?.shortHash).toBe('aaaaaaa')
    expect(row?.age).toBe('10m')
    expect(row?.bucket).toBe('LAST HOUR')
    expect([row?.insertions, row?.deletions]).toEqual([12, 3])
  })

  it('attributes to the REPO, never the worktree the conversation ran in', () => {
    const [row] = commitRiverRows([commit()], LOOK, NOW)
    expect(row?.projectName).toBe('alpha')
    expect(row?.projectIcon).toBe('folder')
  })

  it('never reports a negative age when a committer clock runs ahead', () => {
    const [row] = commitRiverRows([commit({ committedAt: NOW + 5 * MIN })], LOOK, NOW)
    expect(row?.ageMs).toBe(0)
    expect(row?.age).toBe('now')
  })

  it('says out loud when a commit has no conversation behind it', () => {
    const [row] = commitRiverRows([commit({ conversationId: null, conversationName: null })], LOOK, NOW)
    expect(row?.hasConversation).toBe(false)
  })
})

describe('riverBands', () => {
  it('groups in band order and drops the empty bands', () => {
    const rows = commitRiverRows(
      [
        commit({ hash: '1'.repeat(40), committedAt: NOW - 10 * MIN }),
        commit({ hash: '2'.repeat(40), committedAt: at(2026, 7, 20, 9) }),
        commit({ hash: '3'.repeat(40), committedAt: at(2026, 7, 12, 9) }),
      ],
      LOOK,
      NOW,
    )
    expect(riverBands(rows).map(b => b.bucket)).toEqual(['LAST HOUR', 'EARLIER TODAY', 'OLDER'])
  })

  it('prints one separator per band even when a row arrives out of order', () => {
    // A live commit prepends, so the newest row is at the head; a clock that
    // stepped backwards can leave an older row above a newer one. Consecutive
    // grouping would answer that with the same separator twice.
    const rows = commitRiverRows(
      [
        commit({ hash: '1'.repeat(40), committedAt: at(2026, 7, 20, 9) }),
        commit({ hash: '2'.repeat(40), committedAt: NOW - 5 * MIN }),
        commit({ hash: '3'.repeat(40), committedAt: at(2026, 7, 20, 8) }),
      ],
      LOOK,
      NOW,
    )
    const bands = riverBands(rows)
    expect(bands.map(b => b.bucket)).toEqual(['LAST HOUR', 'EARLIER TODAY'])
    expect(bands[1]?.rows).toHaveLength(2)
  })
})
