import { describe, expect, it } from 'bun:test'
import { EPIC_SOFT_LINK_STEP, openEpicRoster, openEpics, wantsEpicRoster } from './epic-roster'
import type { ProjectTaskMeta } from './project-task-types'
import type { TaskStatus } from './task-statuses'

let seq = 0
function card(slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  seq += 1
  return {
    slug,
    status,
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-21T10:00:00Z',
    mtime: seq,
    bodyPreview: '',
    ...extra,
  }
}

/** An epic card: tagged `epic`, so it is an epic before anything points at it. */
function epic(slug: string, status: TaskStatus = 'open', extra: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return card(slug, status, { tags: ['epic'], ...extra })
}

describe('openEpics', () => {
  it('keeps the epics a card could still join', () => {
    const cards = [epic('alpha'), epic('beta', 'in-progress'), epic('gamma', 'inbox')]
    expect(
      openEpics(cards)
        .map(e => e.id)
        .toSorted(),
    ).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('drops done and archived epics -- the one answer that is certainly wrong', () => {
    const cards = [epic('alive'), epic('shipped', 'done'), epic('abandoned', 'archived')]
    expect(openEpics(cards).map(e => e.id)).toEqual(['alive'])
  })

  it('drops an epic id no card on the board defines', () => {
    // `buildEpicIndex` keeps a rollup for a dangling parent so the doctor can
    // report it; offering it here would grow the dangling ref a second child.
    const cards = [card('orphan', 'open', { epic: 'ghost-epic' })]
    expect(openEpics(cards)).toEqual([])
  })

  it('counts children the way the progress bar does -- archived leaves the denominator', () => {
    const cards = [
      epic('e'),
      card('c1', 'done', { epic: 'e' }),
      card('c2', 'open', { epic: 'e' }),
      card('c3', 'archived', { epic: 'e' }),
    ]
    expect(openEpics(cards)[0]).toMatchObject({ id: 'e', done: 1, total: 2 })
  })

  it('orders most recently touched first', () => {
    const cards = [epic('old', 'open', { mtime: 10 }), epic('fresh', 'open', { mtime: 99 })]
    expect(openEpics(cards).map(e => e.id)).toEqual(['fresh', 'old'])
  })
})

describe('openEpicRoster', () => {
  it('is empty when the board has no open epic at all', () => {
    expect(openEpicRoster([card('lonely'), epic('shipped', 'done')])).toBe('')
  })

  it('names each epic by the id a werk-refiner would copy into `epic:`', () => {
    const out = openEpicRoster([epic('epic-scanner-fabric', 'open', { title: 'The scanner fabric' })])
    expect(out).toContain('OPEN EPICS')
    expect(out).toContain('- epic-scanner-fabric -- The scanner fabric (0/0)')
  })

  it('caps the number of epics it names', () => {
    const cards = Array.from({ length: 60 }, (_, i) => epic(`e${i}`))
    const lines = openEpicRoster(cards, { limit: 40 }).split('\n')
    // header + 40 epics + the "and N more" line
    expect(lines).toHaveLength(42)
    expect(lines.filter(l => l.startsWith('- e')).length).toBe(40)
  })

  it('announces what it left out rather than truncating silently', () => {
    const cards = Array.from({ length: 60 }, (_, i) => epic(`e${i}`))
    expect(openEpicRoster(cards, { limit: 40 })).toContain('...and 20 more open epic(s) not listed here')
  })

  it('stays inside the character budget on a board full of long-titled epics', () => {
    const cards = Array.from({ length: 60 }, (_, i) => epic(`epic-number-${i}`, 'open', { title: 'x'.repeat(120) }))
    const out = openEpicRoster(cards)
    // The announcement line is allowed past the budget; the epic lines are not.
    const epicLines = out.split('\n').filter(l => l.startsWith('- epic-number-'))
    expect(epicLines.join('\n').length).toBeLessThanOrEqual(2000)
    expect(epicLines.length).toBeLessThan(40)
    expect(out).toContain('more open epic(s) not listed here')
  })

  it('emits nothing when not even one line fits the budget', () => {
    expect(openEpicRoster([epic('e')], { charBudget: 1 })).toBe('')
  })
})

describe('EPIC_SOFT_LINK_STEP', () => {
  it('is a conditional, so it is also true in a prompt carrying no roster', () => {
    expect(EPIC_SOFT_LINK_STEP).toContain('If an OPEN EPICS list')
  })

  it("states Jonas's rule as the imperative: unsure means leave it unset", () => {
    expect(EPIC_SOFT_LINK_STEP).toContain('Not sure? Leave it unset')
  })

  it('forbids editing the epic card, because parenthood is declared by the child', () => {
    expect(EPIC_SOFT_LINK_STEP).toContain("Never edit the epic's own card")
  })
})

describe('wantsEpicRoster', () => {
  it('sends one to a refine of an orphan card', () => {
    expect(wantsEpicRoster(true, [card('orphan')])).toBe(true)
  })

  it('sends none to a card that already has a parent -- a werk-refiner does not re-home', () => {
    expect(wantsEpicRoster(true, [card('c', 'open', { epic: 'e' })])).toBe(false)
  })

  it('sends none to a mode that is not refine, whatever the cards look like', () => {
    expect(wantsEpicRoster(false, [card('orphan')])).toBe(false)
  })

  it('sends one to a batch where ANY card is still an orphan', () => {
    const batch = [card('parented', 'open', { epic: 'e' }), card('orphan')]
    expect(wantsEpicRoster(true, batch)).toBe(true)
  })

  it('sends none to an empty selection', () => {
    expect(wantsEpicRoster(true, [])).toBe(false)
  })
})
