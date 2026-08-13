/**
 * The launch selector's defaults, as a pure decision rather than a UI assertion.
 *
 * "Work on this epic" must arrive with the NOT-STARTED cards ticked -- opening
 * a selector with nothing selected makes you re-find the cards you were just
 * looking at, which is the whole reason the epic view knows them.
 */

import { buildEpicIndex, notStartedChildren } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import { describe, expect, it } from 'vitest'

function card(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [],
    refs: [],
    created: '',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

/** Exactly what the board hands `openTaskBatch` for an epic. */
function launchPayload(tasks: ProjectTaskMeta[], epicId: string) {
  const rollup = buildEpicIndex(tasks).get(epicId)
  if (!rollup) return null
  return {
    scope: rollup.children.map(c => c.card.slug),
    preselect: notStartedChildren(rollup).map(c => c.slug),
    scopeLabel: rollup.card?.title ?? epicId,
  }
}

const BOARD = [
  card('e', { tags: ['epic'], title: 'ANVIL epic' }),
  card('a', { epic: 'e', status: 'open' }),
  card('b', { epic: 'e', status: 'inbox' }),
  card('c', { epic: 'e', status: 'in-progress' }),
  card('d', { epic: 'e', status: 'done' }),
  card('x', { epic: 'e', status: 'archived' }),
  card('unrelated'),
]

describe('launch payload for an epic', () => {
  it('pre-selects only the not-started children', () => {
    expect(launchPayload(BOARD, 'e')?.preselect.toSorted()).toEqual(['a', 'b'])
  })

  it('never pre-selects work already moving or finished', () => {
    const pre = launchPayload(BOARD, 'e')?.preselect ?? []
    expect(pre).not.toContain('c')
    expect(pre).not.toContain('d')
    expect(pre).not.toContain('x')
  })

  it('scopes the visible list to the epic, not the whole board', () => {
    const scope = launchPayload(BOARD, 'e')?.scope ?? []
    expect(scope).not.toContain('unrelated')
    expect(scope).not.toContain('e')
    expect(scope.length).toBe(5)
  })

  it('scope is a superset of the preselection', () => {
    const p = launchPayload(BOARD, 'e')
    for (const id of p?.preselect ?? []) expect(p?.scope).toContain(id)
  })

  it('labels the scope with the epic title so it is obvious the list is filtered', () => {
    expect(launchPayload(BOARD, 'e')?.scopeLabel).toBe('ANVIL epic')
  })

  it('an epic with nothing left to start pre-selects nothing', () => {
    const done = [card('e', { tags: ['epic'] }), card('a', { epic: 'e', status: 'done' })]
    expect(launchPayload(done, 'e')?.preselect).toEqual([])
  })

  it('returns nothing for an epic the board does not have', () => {
    expect(launchPayload(BOARD, 'ghost')).toBeNull()
  })
})
