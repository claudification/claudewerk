/**
 * @vitest-environment node
 */
/**
 * `isEpicCard` shipped exported, tested, and with ZERO callers -- so on the
 * kanban board an epic rendered pixel-identical to an ordinary card. "THE WERK"
 * epic was reported as "not rendering as an epic" for exactly that reason: it
 * wasn't. Only the EPICS view knew epics existed.
 *
 * These assertions pin the three roles a card can hold, so a card that IS an
 * epic can never again be indistinguishable from one that is not.
 */

import { buildEpicIndex } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { describe, expect, it } from 'vitest'
import { cardEpicRole, epicHueSource } from './card-epic-role'

const card = (slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta =>
  ({ slug, title: slug, status: 'open' as TaskStatus, tags: [], refs: [], ...over }) as ProjectTaskMeta

const index = (cards: ProjectTaskMeta[]) => buildEpicIndex(cards)

describe('cardEpicRole', () => {
  it('calls a tagged epic an epic even before it has children', () => {
    const epic = card('werk-epic', { tags: ['epic'] })
    const role = cardEpicRole(epic, index([epic]))
    expect(role.kind).toBe('epic')
    if (role.kind === 'epic') expect(role.rollup.total).toBe(0)
  })

  it('calls a card with children an epic even when it is not tagged', () => {
    const cards = [card('parent'), card('kid', { epic: 'parent' })]
    expect(cardEpicRole(cards[0], index(cards)).kind).toBe('epic')
  })

  it('carries the live rollup onto the epic card', () => {
    const cards = [
      card('parent', { tags: ['epic'] }),
      card('a', { epic: 'parent', status: 'done' as TaskStatus }),
      card('b', { epic: 'parent' }),
    ]
    const role = cardEpicRole(cards[0], index(cards))
    if (role.kind !== 'epic') throw new Error('expected epic')
    expect(role.rollup.done).toBe(1)
    expect(role.rollup.total).toBe(2)
  })

  it('calls a parented card a child and hands it the PARENT rollup', () => {
    const cards = [card('parent', { tags: ['epic'] }), card('kid', { epic: 'parent' })]
    const role = cardEpicRole(cards[1], index(cards))
    expect(role.kind).toBe('child')
    if (role.kind === 'child') expect(role.rollup?.epicId).toBe('parent')
  })

  it('still calls a card a child when its epic is missing from the board', () => {
    const orphan = card('kid', { epic: 'ghost' })
    const role = cardEpicRole(orphan, index([orphan]))
    expect(role.kind).toBe('child')
    // The badge renders this in red; losing the role entirely would hide it.
    if (role.kind === 'child') expect(role.rollup?.card).toBeNull()
  })

  it('gives an unparented ordinary card no role at all', () => {
    const plain = card('plain')
    expect(cardEpicRole(plain, index([plain])).kind).toBe('none')
  })

  it('prefers the epic role when a card is BOTH an epic and a child', () => {
    // A sub-epic. It must wear its own colour, not its parent's, or a whole
    // branch of the tree collapses into one hue.
    const cards = [
      card('top', { tags: ['epic'] }),
      card('mid', { tags: ['epic'], epic: 'top' }),
      card('leaf', { epic: 'mid' }),
    ]
    expect(cardEpicRole(cards[1], index(cards)).kind).toBe('epic')
  })
})

describe('epicHueSource', () => {
  it('colours an epic by its OWN id, so it matches the children it owns', () => {
    const epic = card('werk-epic', { tags: ['epic'] })
    expect(epicHueSource(cardEpicRole(epic, index([epic])), epic)).toBe('werk-epic')
  })

  it('colours a child by its PARENT id, so the rail groups the lane', () => {
    const cards = [card('parent', { tags: ['epic'] }), card('kid', { epic: 'parent' })]
    expect(epicHueSource(cardEpicRole(cards[1], index(cards)), cards[1])).toBe('parent')
  })

  it('gives an unparented card no hue -- absence is the signal', () => {
    const plain = card('plain')
    expect(epicHueSource(cardEpicRole(plain, index([plain])), plain)).toBeNull()
  })
})
