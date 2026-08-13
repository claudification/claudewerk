import { describe, expect, it } from 'bun:test'
import { checkEpics, type EpicCardView } from './project-doctor-epics'
import type { TaskStatus } from './task-statuses'

function card(id: string, over: Partial<EpicCardView> = {}): EpicCardView {
  return { id, tags: [], status: 'open' as TaskStatus, dependsOn: [], ...over }
}

const epic = (id: string, over: Partial<EpicCardView> = {}) => card(id, { tags: ['epic'], ...over })

function checksFor(cards: EpicCardView[], subject?: string): string[] {
  return checkEpics(cards)
    .filter(f => !subject || f.subject === subject)
    .map(f => f.check)
}

describe('a clean board', () => {
  it('reports nothing', () => {
    expect(checkEpics([epic('e'), card('a', { epic: 'e' }), card('b', { epic: 'e', dependsOn: ['a'] })])).toEqual([])
  })
})

describe('forward references are WARNINGS, never errors', () => {
  it('a card claiming an epic not written yet is a warning', () => {
    const [f] = checkEpics([card('a', { epic: 'later' })])
    expect(f.check).toBe('epic-orphan')
    expect(f.severity).toBe('warning')
  })

  it('depends_on naming a card not written yet is a warning', () => {
    const [f] = checkEpics([epic('e'), card('a', { epic: 'e', dependsOn: ['sibling-to-come'] })])
    expect(f.check).toBe('epic-depends-missing')
    expect(f.severity).toBe('warning')
  })

  it('says out-of-order authoring is fine in the remedy', () => {
    const [f] = checkEpics([card('a', { epic: 'later' })])
    expect(f.remedy).toContain('still to be written')
  })

  it('NOTHING about a forward reference is an error', () => {
    const findings = checkEpics([card('a', { epic: 'ghost', dependsOn: ['also-ghost'] })])
    expect(findings.every(f => f.severity !== 'error')).toBe(true)
  })
})

describe('contradictions are errors', () => {
  it('a card that is its own epic', () => {
    const [f] = checkEpics([epic('e', { epic: 'e' })])
    expect(f.check).toBe('epic-cycle')
    expect(f.severity).toBe('error')
  })

  it('a two-card ring', () => {
    const findings = checkEpics([epic('a', { epic: 'b' }), epic('b', { epic: 'a' })])
    expect(findings.filter(f => f.check === 'epic-cycle')).toHaveLength(2)
    expect(findings.every(f => f.severity === 'error')).toBe(true)
  })

  it('a longer ring still terminates', () => {
    const findings = checkEpics([epic('a', { epic: 'b' }), epic('b', { epic: 'c' }), epic('c', { epic: 'a' })])
    expect(findings.filter(f => f.check === 'epic-cycle').length).toBeGreaterThan(0)
  })

  it('depends_on listing itself can never become ready', () => {
    const [f] = checkEpics([epic('e'), card('a', { epic: 'e', dependsOn: ['a'] })])
    expect(f.check).toBe('epic-depends-self')
    expect(f.severity).toBe('error')
  })

  it('a deep but acyclic chain is NOT reported', () => {
    expect(checksFor([epic('a'), card('b', { epic: 'a', tags: ['epic'] }), card('c', { epic: 'b' })])).toEqual([])
  })
})

describe('pointing at a non-epic', () => {
  it('is a warning, since the fix might be on either card', () => {
    const [f] = checkEpics([card('plain'), card('a', { epic: 'plain' })])
    expect(f.check).toBe('epic-not-an-epic')
    expect(f.severity).toBe('warning')
  })

  it('is not reported once the parent gains the tag', () => {
    expect(checkEpics([epic('plain'), card('a', { epic: 'plain' })])).toEqual([])
  })
})

describe('stale epics', () => {
  it('flags an open epic whose children are all terminal', () => {
    const [f] = checkEpics([
      epic('e'),
      card('a', { epic: 'e', status: 'done' }),
      card('b', { epic: 'e', status: 'archived' }),
    ])
    expect(f.check).toBe('epic-stale')
    expect(f.severity).toBe('info')
  })

  it('stays quiet while any child is still moving', () => {
    expect(
      checksFor([epic('e'), card('a', { epic: 'e', status: 'done' }), card('b', { epic: 'e', status: 'in-review' })]),
    ).toEqual([])
  })

  it('stays quiet for a childless epic', () => {
    expect(checksFor([epic('e')])).toEqual([])
  })

  it('stays quiet once the epic itself is done', () => {
    expect(checksFor([epic('e', { status: 'done' }), card('a', { epic: 'e', status: 'done' })])).toEqual([])
  })
})

describe('cross-epic dependencies', () => {
  it('are info only -- they are legitimate', () => {
    const findings = checkEpics([
      epic('e1'),
      epic('e2'),
      card('a', { epic: 'e1', dependsOn: ['b'] }),
      card('b', { epic: 'e2' }),
    ])
    const f = findings.find(x => x.check === 'epic-depends-outside')
    expect(f?.severity).toBe('info')
  })

  it('are not reported within one epic', () => {
    expect(checksFor([epic('e'), card('a', { epic: 'e', dependsOn: ['b'] }), card('b', { epic: 'e' })])).toEqual([])
  })
})

describe('composing the shared resolver', () => {
  it('resolves every verb on the card, not just parenthood', () => {
    const findings = checkEpics([{ ...card('a'), linkage: { relates_to: ['ghost'], depends_on: ['ghost2'] } }])
    expect(findings.map(f => f.check).toSorted()).toEqual(['epic-depends-missing', 'relates-missing'])
  })

  it('derives linkage from epic/dependsOn when the caller has no bag', () => {
    expect(checkEpics([card('a', { epic: 'ghost' })]).map(f => f.check)).toEqual(['epic-orphan'])
  })

  it('a ring outranks "your parent is not an epic" -- one root cause, one finding', () => {
    const findings = checkEpics([card('a', { epic: 'b' }), card('b', { epic: 'a' })])
    expect(findings.map(f => f.check)).toEqual(['epic-cycle', 'epic-cycle'])
  })

  it('still reports a non-epic parent once the ring is gone', () => {
    expect(checksFor([card('plain'), card('a', { epic: 'plain' })])).toEqual(['epic-not-an-epic'])
  })
})

describe('every finding carries a remedy', () => {
  it('holds for all checks', () => {
    const findings = checkEpics([
      card('orphan', { epic: 'ghost' }),
      epic('loop', { epic: 'loop' }),
      card('plain'),
      card('points-at-plain', { epic: 'plain' }),
      epic('stale'),
      card('kid', { epic: 'stale', status: 'done' }),
    ])
    expect(findings.length).toBeGreaterThan(0)
    for (const f of findings) expect(f.remedy.length).toBeGreaterThan(0)
  })
})
