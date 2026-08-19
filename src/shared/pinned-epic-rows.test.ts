/**
 * A8's arithmetic: what the bar claims, and what the list leaves out.
 *
 * The two failures worth a test are both LIES the pane could tell quietly -- a
 * percentage that counts abandoned cards as finished, and a truncated list that
 * reads as complete.
 *
 * It moved here from `web/` with the fold itself: the SENTINEL runs this now
 * (the `pinned` board op), and the browser only renders what it returns.
 */

import { describe, expect, it } from 'bun:test'
import { MARKER, PINNED_CHILD_CAP, pinnedEpicRows } from './pinned-epic-rows'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

let clock = 1_000

function card(slug: string, status: TaskStatus, extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  clock += 1000
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-19T00:00:00.000Z',
    mtime: clock,
    bodyPreview: '',
    ...extra,
  }
}

const EPIC = 'epic-the-wall'
const PROJECT = 'claude:///Users/j/remote-claude'

function epicCard(extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return card(EPIC, 'open', { title: 'THE WALL', tags: ['epic'], wallPinned: true, ...extra })
}

function child(slug: string, status: TaskStatus, extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return card(slug, status, { epic: EPIC, ...extra })
}

describe('pinnedEpicRows', () => {
  it('only picks up cards that carry the pin', () => {
    const rows = pinnedEpicRows(PROJECT, [epicCard({ wallPinned: undefined }), child('a', 'open')])
    expect(rows).toHaveLength(0)
  })

  it('counts done over total with ARCHIVED out of both sides', () => {
    const rows = pinnedEpicRows(PROJECT, [
      epicCard(),
      child('a', 'done'),
      child('b', 'done'),
      child('c', 'open'),
      // Abandoned: it leaves the denominator entirely rather than counting as
      // progress or as outstanding work.
      child('d', 'archived'),
      child('e', 'archived'),
    ])

    expect(rows[0].done).toBe(2)
    expect(rows[0].total).toBe(3)
    expect(rows[0].pct).toBe(67)
  })

  it('reads 0/0 for an epic whose children were all abandoned, never 100%', () => {
    const rows = pinnedEpicRows(PROJECT, [epicCard(), child('a', 'archived')])
    expect(rows[0]).toMatchObject({ done: 0, total: 0, pct: 0 })
  })

  it('shows a pinned epic that has no children at all', () => {
    const rows = pinnedEpicRows(PROJECT, [epicCard()])
    expect(rows[0]).toMatchObject({ epicId: EPIC, done: 0, total: 0, children: [], hidden: 0 })
  })

  it('never lists a closed card, and counts what the cap hides', () => {
    const open = Array.from({ length: PINNED_CHILD_CAP + 3 }, (_, i) => child(`open-${i}`, 'open'))
    const rows = pinnedEpicRows(PROJECT, [epicCard(), ...open, child('shipped', 'done'), child('dead', 'archived')])

    expect(rows[0].children.map(c => c.slug)).not.toContain('shipped')
    expect(rows[0].children.map(c => c.slug)).not.toContain('dead')
    // The fold keeps the whole list -- the cap is a render decision, and hover
    // has to be able to reveal what it hid.
    expect(rows[0].children).toHaveLength(PINNED_CHILD_CAP + 3)
    expect(rows[0].cap).toBe(PINNED_CHILD_CAP)
    expect(rows[0].hidden).toBe(3)
  })

  it('orders the list most recently moved first', () => {
    const rows = pinnedEpicRows(PROJECT, [epicCard(), child('old', 'open'), child('new', 'open')])
    expect(rows[0].children.map(c => c.slug)).toEqual(['new', 'old'])
  })

  it('marks moving, parked and blocked cards apart', () => {
    const rows = pinnedEpicRows(PROJECT, [
      epicCard(),
      child('moving', 'in-progress'),
      child('question', 'open', { tags: ['needs-overseer'], title: 'which colour?' }),
      child('waiting', 'open', { dependsOn: ['moving'] }),
    ])
    const by = Object.fromEntries(rows[0].children.map(c => [c.slug, c]))

    expect(by.moving.marker).toBe(MARKER.moving)
    expect(by.question.marker).toBe(MARKER.parked)
    expect(by.question.lane).toBe('parked: which colour?')
    expect(by.waiting.marker).toBe(MARKER.blocked)
    expect(by.waiting.lane).toBe('blocked: moving')
  })

  it('a card in flight is MOVING even while a dependency is unfinished', () => {
    const rows = pinnedEpicRows(PROJECT, [
      epicCard(),
      child('dep', 'open'),
      child('busy', 'in-progress', { dependsOn: ['dep'] }),
    ])
    expect(rows[0].children.find(c => c.slug === 'busy')?.marker).toBe(MARKER.moving)
  })
})
