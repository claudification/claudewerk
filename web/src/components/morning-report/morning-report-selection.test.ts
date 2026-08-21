/**
 * THE SAFETY PROPERTY: a fast Execute can never archive a card on a model's hunch.
 *
 * Everything in this file is one shape of that claim. The two fact-derived kinds
 * arrive ticked because they are re-checkable and reversible; the opinion arrives
 * unticked and only a deliberate click on that row arms it; the marker never gets
 * a checkbox at all. A bulk control must not be a way around any of that.
 */

import { archiveCold, flagDuplicate, noteDeleteAt, promoteDelivered } from '@shared/board-sweep-proposals'
import { describe, expect, it } from 'vitest'
import {
  defaultSelection,
  isTickable,
  proposalKey,
  tickAll,
  tickedCount,
  tickedRefs,
  toggle,
  untickAll,
} from './morning-report-selection'

const DELIVERED = promoteDelivered({ card: 'shipped', from: 'open', closes: ['abc1234'] })
const COLD = archiveCold({ card: 'cold-one', created: '2026-01-01T00:00:00Z', ageDays: 233 })
const DUPE = flagDuplicate({ card: 'twin-a', other: 'twin-b', confidence: 0.8, reason: 'same title' })
const DOOMED = noteDeleteAt({ card: 'doomed', deleteAt: '2026-01-01', elapsedDays: 233 })
const ALL = [DELIVERED, COLD, DUPE, DOOMED]

describe('D6 defaults, read off the proposals and not restated', () => {
  it('the two FACT kinds arrive ticked', () => {
    expect(defaultSelection(ALL)).toEqual(new Set([proposalKey(DELIVERED), proposalKey(COLD)]))
  })

  it('the OPINION never arrives ticked', () => {
    expect(defaultSelection([DUPE])).toEqual(new Set())
  })

  it('the marker is not even a candidate', () => {
    expect(defaultSelection([DOOMED])).toEqual(new Set())
  })
})

describe('F18 -- `note-delete-at` cannot be executed at all', () => {
  it('is not tickable, so the row gets no checkbox', () => {
    expect(isTickable(DOOMED)).toBe(false)
    expect(isTickable(DUPE)).toBe(true)
  })

  it('cannot reach `apply` even if its key is forced into the selection', () => {
    // A hand-forced selection is the closest a browser can get to arming it.
    const forced = new Set([proposalKey(DOOMED), proposalKey(COLD)])
    expect(tickedRefs(forced, ALL).map(r => r.card)).toEqual(['cold-one'])
    expect(tickedCount(forced, ALL)).toBe(1)
  })
})

describe('the bulk controls cannot arm an unchecked-by-default kind', () => {
  it('TICK ALL ticks the fact kinds and leaves the duplicate alone', () => {
    const selection = tickAll(new Set(), ALL)
    expect(selection.has(proposalKey(DELIVERED))).toBe(true)
    expect(selection.has(proposalKey(COLD))).toBe(true)
    // The whole point. The cheapest gesture on the panel stays the safe one.
    expect(selection.has(proposalKey(DUPE))).toBe(false)
    expect(selection.has(proposalKey(DOOMED))).toBe(false)
  })

  it('TICK ALL does not undo a duplicate somebody deliberately ticked', () => {
    const deliberate = new Set([proposalKey(DUPE)])
    expect(tickAll(deliberate, ALL).has(proposalKey(DUPE))).toBe(true)
  })

  it('UNTICK ALL really is everything -- unticking is always safe', () => {
    expect(untickAll()).toEqual(new Set())
  })

  it('a board of nothing but opinions gives TICK ALL nothing to do', () => {
    expect(tickAll(new Set(), [DUPE, DOOMED])).toEqual(new Set())
  })
})

describe('what reaches `apply`', () => {
  it('only the ticked rows, in the report order', () => {
    const selection = new Set([proposalKey(COLD), proposalKey(DELIVERED)])
    expect(tickedRefs(selection, ALL)).toEqual([
      { kind: 'promote-delivered', card: 'shipped' },
      { kind: 'archive-cold', card: 'cold-one' },
    ])
  })

  it('a duplicate carries the card it points at -- `duplicate-of:<id>` needs it', () => {
    expect(tickedRefs(new Set([proposalKey(DUPE)]), ALL)).toEqual([
      { kind: 'flag-duplicate', card: 'twin-a', other: 'twin-b' },
    ])
  })

  it('an empty selection sends nothing', () => {
    expect(tickedRefs(new Set(), ALL)).toEqual([])
  })

  it('toggling is symmetric', () => {
    const key = proposalKey(DUPE)
    expect(toggle(new Set(), key).has(key)).toBe(true)
    expect(toggle(new Set([key]), key).has(key)).toBe(false)
  })
})
