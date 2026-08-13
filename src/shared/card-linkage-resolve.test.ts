import { describe, expect, it } from 'bun:test'
import { readLinkage } from './card-linkage-read'
import { type LinkedCard, linkedIds, resolveLinkage } from './card-linkage-resolve'

/** Build a card straight from frontmatter, so every test also proves the read
 *  path -- an alias tested only through a hand-built CardLinkage proves nothing. */
function card(id: string, meta: Record<string, unknown> = {}): LinkedCard {
  return { id, linkage: readLinkage(meta) }
}

const checks = (cards: LinkedCard[]) => resolveLinkage(cards).map(f => f.check)
const bySubject = (cards: LinkedCard[], id: string) => resolveLinkage(cards).filter(f => f.subject === id)

describe('THE RULE: a target that does not exist yet is a WARNING', () => {
  it('holds for epic', () => {
    const [f] = resolveLinkage([card('a', { epic: 'not-written-yet' })])
    expect(f.check).toBe('epic-orphan')
    expect(f.severity).toBe('warning')
  })

  it('holds for depends_on', () => {
    const [f] = resolveLinkage([card('a', { depends_on: ['not-written-yet'] })])
    expect(f.check).toBe('epic-depends-missing')
    expect(f.severity).toBe('warning')
  })

  it('holds for relates_to', () => {
    const [f] = resolveLinkage([card('a', { relates_to: ['not-written-yet'] })])
    expect(f.check).toBe('relates-missing')
    expect(f.severity).toBe('warning')
  })

  it('holds for blocked_by, which resolves as depends_on', () => {
    const [f] = resolveLinkage([card('a', { blocked_by: ['not-written-yet'] })])
    expect(f.check).toBe('epic-depends-missing')
    expect(f.severity).toBe('warning')
  })

  it('holds for EVERY verb at once -- no forward reference is ever an error', () => {
    const findings = resolveLinkage([
      card('a', {
        epic: 'ghost-1',
        depends_on: ['ghost-2'],
        blocked_by: ['ghost-3'],
        relates_to: ['ghost-4'],
        see_also: ['ghost-5'],
        blocks: ['ghost-6'],
      }),
    ])
    expect(findings.length).toBe(6)
    expect(findings.every(f => f.severity === 'warning')).toBe(true)
  })

  it('says out-of-order authoring is fine, so nobody stops writing links', () => {
    const [f] = resolveLinkage([card('a', { epic: 'later' })])
    expect(f.remedy).toContain('still to be written')
  })
})

describe('contradictions are errors', () => {
  it('a card that is its own epic', () => {
    const [f] = resolveLinkage([card('e', { epic: 'e' })])
    expect(f.check).toBe('epic-cycle')
    expect(f.severity).toBe('error')
  })

  it('a self-epic is reported ONCE, not as a self and a ring', () => {
    expect(checks([card('e', { epic: 'e' })])).toEqual(['epic-cycle'])
  })

  it('depends_on listing itself can never become ready', () => {
    const [f] = resolveLinkage([card('a', { depends_on: ['a'] })])
    expect(f.check).toBe('epic-depends-self')
    expect(f.severity).toBe('error')
  })

  it('a two-card epic ring reports both ends', () => {
    const findings = resolveLinkage([card('a', { epic: 'b' }), card('b', { epic: 'a' })])
    expect(findings.filter(f => f.check === 'epic-cycle')).toHaveLength(2)
    expect(findings.every(f => f.severity === 'error')).toBe(true)
  })

  it('names the whole ring in the problem line', () => {
    const [f] = resolveLinkage([card('a', { epic: 'b' }), card('b', { epic: 'a' })])
    expect(f.problem).toContain('a -> b -> a')
  })
})

describe('depends_on rings -- the gap the per-verb code left', () => {
  it('two cards each waiting on the other is an error', () => {
    const findings = resolveLinkage([card('a', { depends_on: ['b'] }), card('b', { depends_on: ['a'] })])
    expect(findings.filter(f => f.check === 'depends-cycle')).toHaveLength(2)
    expect(findings.every(f => f.severity === 'error')).toBe(true)
  })

  it('a three-card ring is caught too', () => {
    const findings = resolveLinkage([
      card('a', { depends_on: ['b'] }),
      card('b', { depends_on: ['c'] }),
      card('c', { depends_on: ['a'] }),
    ])
    expect(findings.filter(f => f.check === 'depends-cycle')).toHaveLength(3)
  })

  it('a ring reached through a BRANCH is still caught', () => {
    const findings = resolveLinkage([
      card('a', { depends_on: ['dead-end', 'b'] }),
      card('b', { depends_on: ['a'] }),
      card('dead-end'),
    ])
    expect(findings.some(f => f.check === 'depends-cycle')).toBe(true)
  })

  it('a diamond is NOT a ring', () => {
    expect(
      checks([
        card('top', { depends_on: ['left', 'right'] }),
        card('left', { depends_on: ['bottom'] }),
        card('right', { depends_on: ['bottom'] }),
        card('bottom'),
      ]),
    ).toEqual([])
  })

  it('one card reported once even when it sits on two rings', () => {
    const findings = bySubject(
      [card('a', { depends_on: ['b', 'c'] }), card('b', { depends_on: ['a'] }), card('c', { depends_on: ['a'] })],
      'a',
    )
    expect(findings.filter(f => f.check === 'depends-cycle')).toHaveLength(1)
  })

  it('a long chain terminates instead of hanging', () => {
    const chain = Array.from({ length: 200 }, (_, i) => card(`n${i}`, { depends_on: [`n${i + 1}`] }))
    expect(resolveLinkage(chain).filter(f => f.check === 'depends-cycle')).toHaveLength(0)
  })
})

describe('relates_to asserts no order, so a loop is not a contradiction', () => {
  it('a symmetric pair is completely clean', () => {
    expect(checks([card('a', { relates_to: ['b'] }), card('b', { relates_to: ['a'] })])).toEqual([])
  })

  it('naming itself is pointless, not fatal', () => {
    const [f] = resolveLinkage([card('a', { relates_to: ['a'] })])
    expect(f.check).toBe('relates-self')
    expect(f.severity).toBe('info')
  })

  it('a one-sided link is info -- the other end may simply not be written yet', () => {
    const [f] = resolveLinkage([card('a', { relates_to: ['b'] }), card('b')])
    expect(f.check).toBe('relates-to-one-sided')
    expect(f.severity).toBe('info')
    expect(f.remedy).toContain('relates_to: [a]')
  })

  it('is never reported one-sided when the target does not exist -- one finding, not two', () => {
    expect(checks([card('a', { relates_to: ['ghost'] })])).toEqual(['relates-missing'])
  })

  it('see_also on one end and relates_to on the other still reads as symmetric', () => {
    expect(checks([card('a', { see_also: ['b'] }), card('b', { relates_to: ['a'] })])).toEqual([])
  })
})

describe('ordering verbs are not checked for symmetry', () => {
  it('a one-way depends_on is exactly right and reported as nothing', () => {
    expect(checks([card('a', { depends_on: ['b'] }), card('b')])).toEqual([])
  })
})

describe('a clean board', () => {
  it('reports nothing at all', () => {
    expect(
      checks([
        card('e'),
        card('a', { epic: 'e' }),
        card('b', { epic: 'e', depends_on: ['a'] }),
        card('c', { epic: 'e', blocked_by: ['b'] }),
      ]),
    ).toEqual([])
  })
})

describe('every finding carries a remedy', () => {
  it('holds across every verb and every severity', () => {
    const findings = resolveLinkage([
      card('a', { epic: 'ghost', depends_on: ['a'], relates_to: ['b'], blocks: ['ghost2'] }),
      card('b'),
      card('loop', { epic: 'loop2' }),
      card('loop2', { epic: 'loop' }),
    ])
    expect(findings.length).toBeGreaterThan(4)
    for (const f of findings) expect(f.remedy.length).toBeGreaterThan(0)
  })
})

describe('linkedIds', () => {
  it('reads a verb off a card by its storage key', () => {
    expect(linkedIds(card('a', { blocked_by: ['x'] }), 'depends_on')).toEqual(['x'])
  })

  it('is empty, never undefined, for a verb the card does not use', () => {
    expect(linkedIds(card('a'), 'depends_on')).toEqual([])
  })
})
