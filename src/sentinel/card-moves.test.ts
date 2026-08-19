import { describe, expect, it } from 'bun:test'
import type { ProjectTaskManifestEntry, ProjectTaskMeta } from '../shared/project-task-types'
import type { TaskStatus } from '../shared/task-statuses'
import { deriveCardMoves } from './card-moves'

const PROJECT = 'claude://default/repo'
const NOW = 1_700_000_000_000

function entry(slug: string, status: TaskStatus, mtime = 1): ProjectTaskManifestEntry {
  return { slug, status, mtime }
}

function note(slug: string, status: TaskStatus, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status,
    title: `title of ${slug}`,
    tags: [],
    refs: [],
    created: '2026-08-19T00:00:00.000Z',
    mtime: 1,
    bodyPreview: '',
    ...over,
  }
}

function prevOf(entries: ProjectTaskManifestEntry[]): Map<string, ProjectTaskManifestEntry> {
  return new Map(entries.map(e => [e.slug, e]))
}

describe('deriveCardMoves', () => {
  it('emits exactly one move per lane transition, with both lanes correct', () => {
    const prev = prevOf([entry('a', 'open'), entry('b', 'inbox')])
    const next = [entry('a', 'in-progress', 2), entry('b', 'inbox')]
    const notes = [note('a', 'in-progress', { priority: 'high' }), note('b', 'inbox')]

    const moves = deriveCardMoves(prev, next, notes, PROJECT, NOW)

    expect(moves).toEqual([
      {
        id: 'a',
        project: PROJECT,
        title: 'title of a',
        from: 'open',
        to: 'in-progress',
        priority: 'high',
        epic: undefined,
        ts: NOW,
      },
    ])
  })

  it('carries the epic the card BELONGS to, so a row can paint in its parent hue', () => {
    const prev = prevOf([entry('kid', 'open')])
    const next = [entry('kid', 'done', 2)]
    const notes = [note('kid', 'done', { epic: 'epic-the-wall' })]

    expect(deriveCardMoves(prev, next, notes, PROJECT, NOW)[0]?.epic).toBe('epic-the-wall')
  })

  it('drops an epic card tagged `epic` -- excluded at the source', () => {
    const prev = prevOf([entry('e', 'open')])
    const next = [entry('e', 'in-progress', 2)]
    const notes = [note('e', 'in-progress', { tags: ['epic'] })]

    expect(deriveCardMoves(prev, next, notes, PROJECT, NOW)).toEqual([])
  })

  it('drops an untagged card that other cards claim as their parent', () => {
    const prev = prevOf([entry('e', 'open')])
    const next = [entry('e', 'done', 2)]
    const notes = [note('e', 'done'), note('kid', 'open', { epic: 'e' })]

    expect(deriveCardMoves(prev, next, notes, PROJECT, NOW)).toEqual([])
  })

  it('ignores an edit that bumps mtime without changing the lane', () => {
    const prev = prevOf([entry('a', 'open', 1)])
    const next = [entry('a', 'open', 999)]

    expect(deriveCardMoves(prev, next, [note('a', 'open')], PROJECT, NOW)).toEqual([])
  })

  it('ignores a card that is new to the board -- an addition has no `from` lane', () => {
    const moves = deriveCardMoves(new Map(), [entry('fresh', 'inbox')], [note('fresh', 'inbox')], PROJECT, NOW)

    expect(moves).toEqual([])
  })

  it('skips a card that vanished between the manifest scan and the notes scan', () => {
    const prev = prevOf([entry('gone', 'open')])
    const next = [entry('gone', 'done', 2)]

    expect(deriveCardMoves(prev, next, [], PROJECT, NOW)).toEqual([])
  })

  it('emits one move per card when a single write moves several', () => {
    const prev = prevOf([entry('a', 'open'), entry('b', 'open'), entry('c', 'open')])
    const next = [entry('a', 'done', 2), entry('b', 'done', 2), entry('c', 'open')]
    const notes = [note('a', 'done'), note('b', 'done'), note('c', 'open')]

    expect(deriveCardMoves(prev, next, notes, PROJECT, NOW).map(m => m.id)).toEqual(['a', 'b'])
  })
})
