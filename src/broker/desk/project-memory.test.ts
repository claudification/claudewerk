import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeProjectMemory,
  getBrief,
  getPendingEvents,
  initProjectMemory,
  listBriefs,
  recallBriefs,
  recordRawEvent,
  writeBrief,
} from './project-memory'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'pm-'))
  initProjectMemory(dir)
})
afterEach(() => {
  closeProjectMemory()
  rmSync(dir, { recursive: true, force: true })
})

const KEY = 'claude://default/users/jonas/projects/arr'
const URI = 'claude://default/Users/jonas/projects/arr'

function rec(summary: string, ts: number, kind = 'turn_complete') {
  return recordRawEvent({ projectKey: KEY, projectUri: URI, label: 'arr', kind, summary, ts })
}

describe('project-memory store', () => {
  test('recording raw events creates the brief row and bumps pending', () => {
    expect(rec('turn ended in auth work', 1)).toBe(1)
    expect(rec('spawned conversation indexer', 2)).toBe(2)
    const brief = getBrief(KEY)
    expect(brief?.label).toBe('arr')
    expect(brief?.pendingCount).toBe(2)
    expect(brief?.brief).toBe('')
  })

  test('getPendingEvents returns uncondensed events oldest-first', () => {
    rec('a', 1)
    rec('b', 2)
    const ev = getPendingEvents(KEY)
    expect(ev.map(e => e.summary)).toEqual(['a', 'b'])
  })

  test('writeBrief sets the brief, resets pending, marks + prunes folded events', () => {
    rec('a', 1)
    const id = getPendingEvents(KEY).at(-1)?.id
    writeBrief({ projectKey: KEY, brief: 'Arr is a media indexer. Currently wiring auth.', now: 100, upToEventId: id })
    const b = getBrief(KEY)
    expect(b?.brief).toContain('media indexer')
    expect(b?.pendingCount).toBe(0)
    expect(b?.lastCondensedAt).toBe(100)
    // The folded event was pruned (condensed + before now).
    expect(getPendingEvents(KEY)).toHaveLength(0)
  })

  test('events newer than a prune cutoff survive after a brief write', () => {
    rec('old', 1)
    const firstId = getPendingEvents(KEY).at(-1)?.id
    writeBrief({ projectKey: KEY, brief: 'v1', now: 50, upToEventId: firstId })
    rec('new', 200)
    expect(getPendingEvents(KEY).map(e => e.summary)).toEqual(['new'])
  })

  test('recallBriefs finds a project by condensed-brief FTS', () => {
    rec('x', 1)
    writeBrief({ projectKey: KEY, brief: 'Arr is a media indexer with sonarr/radarr integration.', now: 10 })
    expect(recallBriefs('indexer').map(b => b.projectKey)).toContain(KEY)
    expect(recallBriefs('sonarr')).toHaveLength(1)
    expect(recallBriefs('nonexistentterm')).toHaveLength(0)
  })

  test('listBriefs orders by most-recently-updated', () => {
    recordRawEvent({ projectKey: 'k1', projectUri: 'claude://d/a', label: 'a', kind: 'x', summary: 's', ts: 1 })
    recordRawEvent({ projectKey: 'k2', projectUri: 'claude://d/b', label: 'b', kind: 'x', summary: 's', ts: 5 })
    expect(listBriefs().map(b => b.projectKey)).toEqual(['k2', 'k1'])
  })
})
