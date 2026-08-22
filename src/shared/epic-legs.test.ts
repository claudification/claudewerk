/**
 * THE LEG ARITHMETIC, on its own.
 *
 * Its own file rather than a corner of `epic-run-caps.test.ts` because the
 * question this module answers is not "how does a run render" -- it is "when is a
 * leg over", and that is the decision every other leg test is downstream of. If
 * this file is green and `epic-legs-beat.test.ts` is red, the bug is in the beat's
 * ORDERING; if this one is red, none of the rest means anything.
 */

import { describe, expect, test } from 'bun:test'
import { LEG_HARD_MULTIPLIER, type LegFields, describeLeg, legNumber, legsArmed, nextLeg, readLeg } from './epic-legs'

const RUN: LegFields = { leg: 1, legBudgetUsd: 200, legStartUsd: 0, plan: true }
const run = (over: Partial<LegFields> = {}): LegFields => ({ ...RUN, ...over })

describe('legsArmed', () => {
  test('a budget and a planning stage means legs', () => {
    expect(legsArmed(run())).toBe(true)
  })

  test('a typed zero disarms them, exactly like every other ceiling', () => {
    expect(legsArmed(run({ legBudgetUsd: 0 }))).toBe(false)
  })

  /**
   * THE ONE THAT IS NOT OBVIOUS, and the reason it has a test of its own.
   *
   * A leg boundary's entire payload is a re-plan, and `planningBeat` returns null
   * outright for a run with `plan` off. Arming legs on such a run would give it a
   * soft stop that withholds dispatch and a boundary that dispatches nothing to
   * lift it -- a frozen run rather than a budgeted one.
   */
  test('a run that opted out of planning has NO legs -- the boundary would have nothing to do', () => {
    expect(legsArmed(run({ plan: false }))).toBe(false)
    expect(readLeg(run({ plan: false }), 10_000).budgetUsd).toBe(0)
    expect(readLeg(run({ plan: false }), 10_000).soft).toBe(false)
    expect(readLeg(run({ plan: false }), 10_000).hard).toBe(false)
  })
})

describe('legNumber', () => {
  test('a run armed before legs existed is on its FIRST leg, not on leg 0', () => {
    expect(legNumber({ leg: undefined as unknown as number })).toBe(1)
    expect(legNumber({ leg: 0 })).toBe(1)
    expect(legNumber({ leg: Number.NaN })).toBe(1)
  })

  test('and otherwise says what it says', () => {
    expect(legNumber({ leg: 7 })).toBe(7)
  })
})

describe('readLeg', () => {
  /**
   * MEASURED COST, NEVER A PLANNED SIZE -- the card's first requirement, and the
   * only place it can be asserted, because this is the sole arithmetic there is.
   * `spent` is the run's cumulative ledger, folded by the executor from
   * `turns.cost_usd`; nothing in this module has any other input to be wrong about.
   */
  test('leg spend is the run ledger minus this leg watermark', () => {
    expect(readLeg(run({ leg: 3, legStartUsd: 400 }), 512).spentUsd).toBe(112)
  })

  test('remaining counts down and stops at zero rather than going negative', () => {
    expect(readLeg(run(), 50).remainingUsd).toBe(150)
    expect(readLeg(run(), 260).remainingUsd).toBe(0)
  })

  /**
   * A LEDGER THAT MOVED BACKWARDS UNDER THE WATERMARK. Turn rows are pruned and
   * the conversation registry forgets, so a fold can come back smaller than what
   * the run banked. A negative leg spend would render as budget REMAINING that was
   * never there -- the one direction a brake must never be wrong in.
   */
  test('a ledger below the watermark reads as zero spent, never as negative', () => {
    expect(readLeg(run({ legStartUsd: 400 }), 300).spentUsd).toBe(0)
  })

  test('soft fires AT the budget, not one cent past it', () => {
    expect(readLeg(run(), 199.99).soft).toBe(false)
    expect(readLeg(run(), 200).soft).toBe(true)
  })

  test('hard is the budget times the multiplier, and soft is true under it', () => {
    const hard = readLeg(run(), 200 * LEG_HARD_MULTIPLIER)
    expect(hard.hardUsd).toBe(400)
    expect(hard.hard).toBe(true)
    expect(readLeg(run(), 399.99).hard).toBe(false)
    expect(readLeg(run(), 399.99).soft).toBe(true)
  })
})

describe('nextLeg', () => {
  /**
   * EVERY LEG GETS A WHOLE BUDGET. The soft stop settles rather than kills, so a
   * leg routinely ends OVER its budget -- and carrying that overshoot forward
   * would make the next leg stop early through no fault of its own. The run-level
   * `maxUsd` is what bounds the sum; a leg budget bounds one leg.
   */
  test('the new watermark is the ledger NOW, so an overshoot is not billed to the next leg', () => {
    expect(nextLeg({ leg: 2 }, 430)).toEqual({ leg: 3, legStartUsd: 430 })
    expect(readLeg(run({ leg: 3, legStartUsd: 430 }), 430).spentUsd).toBe(0)
  })
})

describe('describeLeg', () => {
  test('names the leg and both numbers, to the cent', () => {
    expect(describeLeg(readLeg(run({ leg: 2, legStartUsd: 100 }), 312.4))).toBe('leg 2: $212.40 of $200.00')
  })
})
