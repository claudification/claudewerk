import { describe, expect, it } from 'bun:test'
import { planEpicMigration } from './epic-migrate'
import type { ProjectTask } from './project-task-types'

function card(slug: string, over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    body: '',
    bodyPreview: '',
    ...over,
  }
}

const epic = (slug: string, over: Partial<ProjectTask> = {}) => card(slug, { tags: ['epic'], ...over })

describe('planEpicMigration', () => {
  it('adopts children the epic listed in blocks:', () => {
    const plan = planEpicMigration([epic('e'), card('a'), card('b')], new Map([['e', ['a', 'b']]]))
    expect(plan.assignments).toEqual([
      { childId: 'a', epicId: 'e', via: 'parent-blocks' },
      { childId: 'b', epicId: 'e', via: 'parent-blocks' },
    ])
  })

  it('adopts children that named the epic in refs:', () => {
    const plan = planEpicMigration([epic('e'), card('a', { refs: ['e', 'docs/x.md'] })], new Map())
    expect(plan.assignments).toEqual([{ childId: 'a', epicId: 'e', via: 'child-refs' }])
  })

  it('prefers the parent-side signal when both point the same way', () => {
    const plan = planEpicMigration([epic('e'), card('a', { refs: ['e'] })], new Map([['e', ['a']]]))
    expect(plan.assignments).toEqual([{ childId: 'a', epicId: 'e', via: 'parent-blocks' }])
  })

  it('is idempotent -- a card that already has epic: is left alone', () => {
    const plan = planEpicMigration([epic('e'), card('a', { epic: 'e', refs: ['e'] })], new Map([['e', ['a']]]))
    expect(plan.assignments).toEqual([])
  })

  it('never overwrites a human answer with a different epic', () => {
    const plan = planEpicMigration(
      [epic('e1'), epic('e2'), card('a', { epic: 'e2' })],
      new Map([['e1', ['a']]]),
    )
    expect(plan.assignments).toEqual([])
  })

  it('reports a child claimed by two epics instead of guessing', () => {
    const plan = planEpicMigration(
      [epic('e1'), epic('e2'), card('a')],
      new Map([
        ['e1', ['a']],
        ['e2', ['a']],
      ]),
    )
    expect(plan.assignments).toEqual([])
    expect(plan.conflicts).toEqual([{ childId: 'a', epicIds: ['e1', 'e2'] }])
  })

  it('reports listed children that no card matches', () => {
    const plan = planEpicMigration([epic('e')], new Map([['e', ['ghost']]]))
    expect(plan.danglingChildren).toEqual(['ghost'])
    expect(plan.assignments).toEqual([])
  })

  it('refuses to make an epic its own child', () => {
    const plan = planEpicMigration([epic('e', { refs: ['e'] })], new Map([['e', ['e']]]))
    expect(plan.assignments).toEqual([])
    expect(plan.conflicts).toEqual([])
  })

  it('ignores refs to cards that are not epics', () => {
    const plan = planEpicMigration([epic('e'), card('a'), card('b', { refs: ['a'] })], new Map())
    expect(plan.assignments).toEqual([])
  })

  it('lists the epics it found, sorted', () => {
    const plan = planEpicMigration([epic('z'), card('m'), epic('a')], new Map())
    expect(plan.epicIds).toEqual(['a', 'z'])
  })

  it('does nothing on a board with no epics', () => {
    const plan = planEpicMigration([card('a'), card('b')], new Map())
    expect(plan).toMatchObject({ assignments: [], conflicts: [], danglingChildren: [], epicIds: [] })
  })
})
