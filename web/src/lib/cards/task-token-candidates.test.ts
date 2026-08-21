import { describe, expect, test } from 'vitest'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { candidatesFor } from './task-token-candidates'
import type { ProjectOption } from './task-tokens'

const card = (over: Partial<ProjectTaskMeta>): ProjectTaskMeta =>
  ({ slug: 'x', status: 'inbox', title: 'X', tags: [], refs: [], ...over }) as ProjectTaskMeta

const BOARD: ProjectTaskMeta[] = [
  card({ slug: 'epic-the-wall-ii', title: 'THE WALL II', tags: ['epic'] }),
  card({ slug: 'wall-stats', title: 'Wall stats', epic: 'epic-the-wall-ii', status: 'done' }),
  card({ slug: 'wall-pins', title: 'Wall pins', epic: 'epic-the-wall-ii', status: 'open' }),
  card({ slug: 'old-thing', title: 'Old thing', status: 'archived', tags: ['legacy'] }),
  card({ slug: 'perf-fix', title: 'Perf fix', tags: ['perf'] }),
]

const PROJECTS: ProjectOption[] = [
  { uri: 'claude://studio/Users/j/projects/remote-claude', name: 'CLAUDEWERK', path: '/Users/j/projects/remote-claude' },
  { uri: 'claude://studio/Users/j/projects/yemaya', name: 'YEMAYA', path: '/Users/j/projects/yemaya' },
]

const src = () => ({ tasks: BOARD, projects: PROJECTS })

describe('project candidates', () => {
  test('offers every known project, with its path as the disambiguator', () => {
    const rows = candidatesFor('project', src(), '')
    expect(rows.map(r => r.label)).toEqual(['CLAUDEWERK', 'YEMAYA'])
    expect(rows[0].detail).toBe('/Users/j/projects/remote-claude')
  })

  test('the VALUE is the uri -- the label is only for reading', () => {
    expect(candidatesFor('project', src(), 'claudewerk')[0].value).toBe(
      'claude://studio/Users/j/projects/remote-claude',
    )
  })

  test('matches on path as well as name, so a half-remembered folder finds it', () => {
    expect(candidatesFor('project', src(), 'yemaya').map(r => r.label)).toEqual(['YEMAYA'])
  })
})

describe('epic candidates', () => {
  test('offers epics and rolls up their child progress', () => {
    const rows = candidatesFor('epic', src(), '')
    const wall = rows.find(r => r.value === 'epic-the-wall-ii')
    expect(wall).toBeDefined()
    expect(wall?.detail).toBe('THE WALL II -- 1/2')
  })

  test('a plain card is not an epic', () => {
    expect(candidatesFor('epic', src(), '').some(r => r.value === 'perf-fix')).toBe(false)
  })

  test('matches on title as well as id', () => {
    expect(candidatesFor('epic', src(), 'WALL II').map(r => r.value)).toContain('epic-the-wall-ii')
  })
})

describe('card candidates for +depends-on / &relates-to', () => {
  test('archived cards are excluded so live matches are not buried', () => {
    const rows = candidatesFor('dependsOn', src(), '')
    expect(rows.some(r => r.value === 'old-thing')).toBe(false)
    expect(rows.some(r => r.value === 'perf-fix')).toBe(true)
  })

  test('both list kinds draw from the same pool', () => {
    expect(candidatesFor('relatesTo', src(), 'perf')).toEqual(candidatesFor('dependsOn', src(), 'perf'))
  })

  test('detail carries the status so you can see what you are pointing at', () => {
    expect(candidatesFor('dependsOn', src(), 'wall-pins')[0].detail).toBe('Wall pins -- open')
  })
})

describe('priority candidates', () => {
  test('offers all three, high first', () => {
    expect(candidatesFor('priority', src(), '').map(r => r.value)).toEqual(['high', 'medium', 'low'])
  })

  test('a partial query narrows to one', () => {
    expect(candidatesFor('priority', src(), 'hi').map(r => r.value)).toEqual(['high'])
  })
})

describe('tag candidates', () => {
  test('unions board tags and renders them hash-prefixed', () => {
    const rows = candidatesFor('tag', src(), '')
    expect(rows.map(r => r.value)).toEqual(['epic', 'legacy', 'perf'])
    expect(rows[0].label).toBe('#epic')
  })

  test('tags come from archived cards too -- a label is not scoped to a lane', () => {
    expect(candidatesFor('tag', src(), 'leg').map(r => r.value)).toEqual(['legacy'])
  })
})
