import { describe, expect, it } from 'bun:test'
import { WALL_SECTION_CAP, type WallCommitRow, type WallPulseRow } from '../../shared/wall'
import { createWallState } from './wall-state'

function row(id: string, over: Partial<WallPulseRow> = {}): WallPulseRow {
  return {
    id,
    project: 'claude://default/p',
    title: id,
    status: 'active',
    lastActivity: 1,
    ...over,
  }
}

function commit(hash: string, repoUri = 'claude://default/p'): WallCommitRow {
  return {
    hash,
    shortHash: hash.slice(0, 7),
    repoUri,
    repoName: 'p',
    branch: 'main',
    subject: hash,
    authorName: 'jonas',
    insertions: 1,
    deletions: 0,
    fileCount: 1,
    committedAt: 1,
  }
}

describe('wall state: coalesce, never queue', () => {
  it('folds forty ticks of one conversation into ONE row', () => {
    const s = createWallState()
    for (let i = 0; i < 40; i++) s.notePulse(row('a', { lastActivity: i }))

    const delta = s.drain()
    expect(delta.pulseChanged).toHaveLength(1)
    expect(delta.pulseChanged[0]?.lastActivity).toBe(39)
    // Every source event is still COUNTED -- coalescing hides the sends, not the truth.
    expect(delta.coalesced).toBe(40)
  })

  it('drain resets the dirty set so a quiet window is not dirty', () => {
    const s = createWallState()
    s.notePulse(row('a'))
    s.drain()
    expect(s.isDirty()).toBe(false)
    expect(s.drain().pulseChanged).toHaveLength(0)
  })

  it('a removed conversation leaves the snapshot and lands in `gone`', () => {
    const s = createWallState()
    s.notePulse(row('a'))
    s.drain()
    s.notePulseGone('a')

    const delta = s.drain()
    expect(delta.pulseGone).toEqual(['a'])
    expect(s.snapshot().pulse).toHaveLength(0)
  })

  it('a change AFTER a removal wins -- the row comes back rather than staying gone', () => {
    const s = createWallState()
    s.notePulse(row('a'))
    s.drain()
    s.notePulseGone('a')
    s.notePulse(row('a', { lastActivity: 9 }))

    const delta = s.drain()
    expect(delta.pulseGone).toEqual([])
    expect(delta.pulseChanged.map(r => r.id)).toEqual(['a'])
  })

  it('caps an event section at WALL_SECTION_CAP, dropping the OLDEST and counting it', () => {
    const s = createWallState()
    const over = 5
    for (let i = 0; i < WALL_SECTION_CAP + over; i++) s.noteCommit(commit(`c${i}`))

    const delta = s.drain()
    expect(delta.commits).toHaveLength(WALL_SECTION_CAP)
    expect(delta.commits[0]?.hash).toBe(`c${over}`)
    expect(delta.dropped).toBe(over)
  })

  it('keyed sections keep only the latest sample per key', () => {
    const s = createWallState()
    s.noteHost({ nodeId: 'studio', alias: 'studio', at: 1, cpuPct: 10 })
    s.noteHost({ nodeId: 'studio', alias: 'studio', at: 2, cpuPct: 90 })
    s.notePlan({ profile: 'a', utilization: 10, at: 1 })
    s.notePlan({ profile: 'a', node: 'nas', utilization: 20, at: 1 })

    const delta = s.drain()
    expect(delta.hosts).toHaveLength(1)
    expect(delta.hosts[0]?.cpuPct).toBe(90)
    // profile alone and profile@node are DIFFERENT series, not the same one twice.
    expect(delta.plan).toHaveLength(2)
  })
})

describe('wall state: fleet counters', () => {
  it('counts only the projects the caller may read', () => {
    const s = createWallState()
    s.notePulse(row('a', { project: 'claude://default/mine', host: 'studio' }))
    s.notePulse(row('b', { project: 'claude://default/mine', status: 'idle' }))
    s.notePulse(row('c', { project: 'claude://default/theirs', host: 'nas' }))

    expect(s.countersFor().conversations).toBe(3)
    const mine = s.countersFor(p => p === 'claude://default/mine')
    expect(mine).toEqual({ conversations: 2, active: 1, idle: 1, blocked: 0, projects: 1, hosts: 1 })
  })

  it('a blocked row is blocked, not active', () => {
    const s = createWallState()
    s.notePulse(row('a', { status: 'active', blocked: true }))
    expect(s.countersFor()).toMatchObject({ blocked: 1, active: 0 })
  })

  it('marks the fleet dirty on a status change but not on a mere activity bump', () => {
    const s = createWallState()
    s.notePulse(row('a', { status: 'active' }))
    s.drain()

    s.notePulse(row('a', { status: 'active', lastActivity: 2 }))
    expect(s.drain().fleetDirty).toBe(false)

    s.notePulse(row('a', { status: 'idle' }))
    expect(s.drain().fleetDirty).toBe(true)
  })
})
