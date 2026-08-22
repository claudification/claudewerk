/**
 * WHAT A BEAT DOES ABOUT LEGS -- the ORDERING, which is the half `epic-legs.ts`
 * cannot get wrong on its own.
 *
 * `epic-legs.test.ts` asserts when a leg is over. This file asserts what happens
 * then, and every test here is written to die if a branch moves: the soft stop
 * has to sit on the `when` axis and NOT in `capBeat` (or a leg would park the run
 * instead of settling it), the hard cap has to sit IN `capBeat` above the werk-
 * master hold (or a wedged supervisor would outrank a runaway leg), and the
 * boundary has to require a drained fleet (or a re-plan would run against a board
 * about to move underneath it).
 *
 * Its own file rather than more of `epic-beat.test.ts`: that fixture deliberately
 * has legs DISARMED so its 200-odd assertions keep being about what they were
 * about, and a leg test that had to remember to re-arm them in every call would
 * eventually forget.
 */

import { describe, expect, test } from 'bun:test'
import type { EpicPlan } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicBeatInput, planBeat } from './epic-beat'

function card(slug: string): ProjectTaskMeta {
  return { slug, status: 'open', title: slug, tags: [], refs: [], created: '', mtime: 0, bodyPreview: '' }
}

const T0 = Date.parse('2026-08-21T00:00:00.000Z')

/** A run WITH legs armed -- `plan` on and a $200 budget, the shipped defaults. */
const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  // DELIBERATELY HUGE. Every test below is about the LEG ceiling, and a run-level
  // ceiling of $100 would trip first and silently make half this file assert the
  // wrong brake.
  maxUsd: 100_000,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  legBudgetUsd: 200,
  legStartUsd: 0,
  leg: 1,
  concurrency: 3,
  plan: true,
  // The planning generation has already run, so `planningBeat` is out of the way
  // and what these tests see is the leg machinery rather than generation 0.
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

const EMPTY_PLAN: EpicPlan = {
  rollup: null,
  dispatch: [],
  verify: [],
  questions: [],
  heldBack: [],
  waitingOnDeps: [],
  unspawnable: [],
  needsRefine: [],
  exhausted: [],
  alreadyRun: [],
  awaitingDeploy: [],
  unlanded: [],
  complete: false,
}

function beat(over: Partial<EpicBeatInput> = {}, plan: Partial<EpicPlan> = {}, run: Partial<EpicRunSnapshot> = {}) {
  return planBeat({
    run: { ...RUN, ...run },
    gen: run.gen ?? RUN.gen,
    plan: { ...EMPTY_PLAN, ...plan },
    inFlight: [],
    werkMasterAlive: false,
    unacknowledged: [],
    windowOpen: true,
    boardFingerprint: '',
    spentUsd: 0,
    nowMs: T0,
    ...over,
  })
}

const kinds = (b: ReturnType<typeof planBeat>) => b.actions.map(a => a.kind)

describe('the soft stop settles rather than kills', () => {
  test('under budget, work goes out as normal', () => {
    expect(kinds(beat({ spentUsd: 199 }, { dispatch: [card('t1')] }))).toEqual(['dispatch'])
  })

  /**
   * THE CENTRAL ASSERTION OF THE WHOLE FEATURE. A leg at its budget stops
   * DISPATCHING. It does not park, it does not abort, and nothing that is already
   * out is touched -- killing a leg at its ceiling throws away the half-finished
   * work of every seat it had, which is the most expensive way to save money
   * available to this engine.
   */
  test('at budget, nothing new dispatches and the run is NOT parked', () => {
    const b = beat({ spentUsd: 200, inFlight: ['t9'] }, { dispatch: [card('t1')] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('leg budget SPENT')
  })

  /**
   * AND VERIFICATION STILL GOES OUT -- which is not a nicety, it is what makes the
   * boundary reachable at all. A leg that withheld verdicts could never settle the
   * work it is waiting on, so the drain it is waiting for could not happen and the
   * soft stop would be a permanent freeze.
   */
  test('but a verdict still goes out, or the leg could never drain', () => {
    const b = beat({ spentUsd: 250, inFlight: ['t9'] }, { dispatch: [card('t1')], verify: [card('t2')] })
    expect(kinds(b)).toEqual(['verify'])
  })

  test('the held beat names what it is waiting for, so a quiet run is explicable', () => {
    const b = beat({ spentUsd: 212.4, inFlight: ['t9'] }, { dispatch: [card('t1')] })
    expect(b.note).toContain('leg 1: $212.40 of $200.00')
    expect(b.note).toContain('settling 1 in flight')
  })

  /**
   * A FORCED BEAT MAY NOT SPEND PAST IT. The appointment and headroom gates are
   * overridable because they are one human's call about one run's TIMING; this is
   * a budget that human set, and a BEAT NOW that walked through it would make the
   * number decorative.
   */
  test('BEAT NOW does not override the leg budget', () => {
    expect(kinds(beat({ spentUsd: 200, inFlight: ['t9'], forced: true }, { dispatch: [card('t1')] }))).toEqual([])
  })

  test('legs disarmed by a typed zero changes nothing at all', () => {
    // Far past ANY leg threshold, and still under this fixture's run ceiling --
    // otherwise `capBeat` parks on `maxUsd` and the test proves nothing.
    const b = beat({ spentUsd: 50_000 }, { dispatch: [card('t1')] }, { legBudgetUsd: 0 })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('a run with no planning stage has no leg budget to be held by', () => {
    // Far past ANY leg threshold, and still under this fixture's run ceiling --
    // otherwise `capBeat` parks on `maxUsd` and the test proves nothing.
    const b = beat({ spentUsd: 50_000 }, { dispatch: [card('t1')] }, { plan: false })
    expect(kinds(b)).toEqual(['dispatch'])
  })
})

describe('the boundary: drained, then re-plan', () => {
  test('nothing in flight and nothing to verify ENDS the leg', () => {
    const b = beat({ spentUsd: 212.4 }, { dispatch: [card('t1')] })
    expect(kinds(b)).toEqual(['leg-end'])
    expect(b.actions[0]).toMatchObject({ kind: 'leg-end', leg: 1, reason: 'budget', spentUsd: 212.4, budgetUsd: 200 })
  })

  /**
   * A BOUNDARY TAKEN WITH WORK STILL OUT would re-plan a board about to move
   * underneath the werk-planner -- which is precisely the race generation 0
   * suppresses dispatch for.
   */
  test('a seat still in flight holds the boundary', () => {
    expect(kinds(beat({ spentUsd: 300, inFlight: ['t9'] }))).toEqual([])
  })

  test('a card still awaiting a verdict holds it too -- both lanes have to be empty', () => {
    expect(kinds(beat({ spentUsd: 300 }, { verify: [card('t2')] }))).toEqual(['verify'])
  })

  /**
   * THE PATCH IS THE MECHANISM. Clearing `planned` is what makes the NEXT beat
   * dispatch a werk-planner through `planningBeat` -- the generation-0 pass reused
   * whole, which is what the card asked for, rather than a second way to spawn one.
   */
  test('the boundary clears `planned`, rolls the counter and moves the watermark', () => {
    const b = beat({ spentUsd: 212.4 })
    expect(b.patch).toMatchObject({ planned: false, leg: 2, legStartUsd: 212.4 })
  })

  test('and the next beat then dispatches the werk-planner, naming the leg', () => {
    const b = beat({ boardFingerprint: 'now' }, {}, { planned: false, leg: 2, legStartUsd: 212.4, spentUsd: 212.4 })
    expect(kinds(b)).toEqual(['plan'])
    expect(b.note).toContain('leg 2')
    expect(b.note).toContain('re-planning the remainder')
  })

  /**
   * THE SECOND WAY A LEG ENDS: nothing ready is left to dispatch. The natural
   * floor, so a leg cannot sit burning beats waiting for a budget it will never
   * spend.
   */
  test('a leg with money left but no work ends too, and says why', () => {
    const b = beat({}, { idleReason: 'every card is waiting on t1' } as Partial<EpicPlan>)
    expect(kinds(b)).toEqual(['leg-end'])
    expect(b.actions[0]).toMatchObject({ reason: 'dry', detail: 'every card is waiting on t1' })
  })

  /**
   * THE TERMINATION ARGUMENT, and the test that exists because getting it wrong
   * was a live bug during this card's build.
   *
   * A dry boundary must CARRY the dry streak. Clear it and the two-dry park below
   * becomes unreachable: a run with nothing left to do re-plans, finds nothing,
   * re-plans, forever, billing a werk-planner every round. Carried, it gets exactly
   * one re-plan and then parks.
   */
  test('a DRY boundary carries the dry streak, so the two-dry park stays reachable', () => {
    expect(beat({}, { idleReason: 'nothing' } as Partial<EpicPlan>).patch).toMatchObject({ dryGens: 1 })
  })

  test('and the second dry generation PARKS instead of re-planning again', () => {
    const b = beat({}, { idleReason: 'nothing' } as Partial<EpicPlan>, { dryGens: 1 })
    expect(kinds(b)).toEqual(['park'])
  })

  /** A BUDGET boundary clears it: work was moving right up until the money ran
   *  out, which is the opposite of an idle run. */
  test('a BUDGET boundary clears the dry streak', () => {
    expect(beat({ spentUsd: 250 }, { dispatch: [card('t1')] }, { dryGens: 1 }).patch).toMatchObject({ dryGens: 0 })
  })
})

describe('the re-plan notifies rather than gates', () => {
  const OWED = { plan: true, planned: false } as Partial<EpicRunSnapshot>

  test('generation 0 still CHECKPOINTS -- nothing has dispatched, so stopping costs nothing', () => {
    const b = beat({ boardFingerprint: 'after' }, {}, { ...OWED, leg: 1, planBaseline: 'before' })
    expect(b.actions[0]).toMatchObject({ kind: 'plan-checkpoint', gate: true, leg: 1 })
  })

  /**
   * A LEG'S RE-PLAN DOES NOT GATE, and that is Jonas's `auto` choice in code. A
   * re-plan that does its job ALWAYS changes the board -- that is the entire
   * reason the boundary exists -- so gating there would stop the run on every
   * single leg and train exactly the reflex a checkpoint must never train.
   */
  test('a leg re-plan carries gate=false: notify, and carry on', () => {
    const b = beat({ boardFingerprint: 'after' }, {}, { ...OWED, leg: 2, planBaseline: 'before' })
    expect(b.actions[0]).toMatchObject({ kind: 'plan-checkpoint', gate: false, leg: 2 })
    expect(b.note).toContain('notifying and continuing')
  })

  test('a re-plan that changed nothing is accepted on either leg', () => {
    expect(kinds(beat({ boardFingerprint: 'same' }, {}, { ...OWED, leg: 2, planBaseline: 'same' }))).toEqual([
      'plan-accept',
    ])
  })
})

describe('the hard cap kills', () => {
  /**
   * TWICE THE BUDGET AND IT PARKS ON THE SPOT -- no settle, no drain, no waiting.
   * The soft stop was given its chance at $200 and the spend climbed to $400
   * anyway, so there is nothing left to be careful with.
   */
  test('at twice the budget the run parks, without waiting for anything to settle', () => {
    const b = beat({ spentUsd: 400, inFlight: ['t9'] }, { dispatch: [card('t1')] })
    expect(kinds(b)).toEqual(['park'])
  })

  /**
   * AND IT SAYS WHAT IT DID NOT DO. No seat-stopping primitive reaches a beat --
   * the sentinel owns the hosts -- so a park note that implied the fleet was
   * stopped would be a lie a human acts on.
   */
  test('the park names the seats it did NOT stop', () => {
    const b = beat({ spentUsd: 400, inFlight: ['t9', 't8'] })
    expect(b.actions[0]).toMatchObject({ kind: 'park' })
    const reason = (b.actions[0] as { reason: string }).reason
    expect(reason).toContain('NOT stopped by this park: t9, t8')
    expect(reason).toContain('$400.00')
  })

  /**
   * IT OUTRANKS THE WERK-MASTER HOLD. `capBeat` runs before `werkMasterGate`, so a
   * runaway leg parks whatever the lease says -- otherwise a wedged supervisor
   * would hold a run that is burning money open until its lease aged out.
   */
  test('a live werk-master does not hold a run that is over the hard cap', () => {
    expect(kinds(beat({ spentUsd: 500, werkMasterAlive: true }))).toEqual(['park'])
  })

  /** The RUN ceiling is the bigger unit and is the one a human needs told. */
  test('the run-level maxUsd outranks it when both are blown', () => {
    const b = beat({ spentUsd: 500 }, {}, { maxUsd: 100 })
    expect(b.note).toContain('spend ceiling reached')
  })

  test('a paused run is touched by none of it', () => {
    const b = beat({ spentUsd: 5000 }, { dispatch: [card('t1')] }, { status: 'paused' })
    expect(b.actions).toEqual([])
    expect(b.patch).toBeUndefined()
  })
})

/**
 * SPEND IS READ FROM MEASURED COST, NEVER FROM A PLANNED SIZE -- the card's first
 * requirement, asserted where it can actually be broken.
 *
 * `spentSoFar` is the higher of the ledger banked on the run and the fold the
 * executor took THIS beat from `turns.cost_usd`. Both are measured. The direction
 * matters: turn rows are pruned and the registry forgets, so the fresh fold can
 * come back smaller -- and a brake that garbage collection can lower is not a
 * brake.
 */
describe('the leg is judged on measured spend', () => {
  test('a fresh fold above the banked ledger trips the leg', () => {
    expect(kinds(beat({ spentUsd: 250 }, { dispatch: [card('t1')] }, { spentUsd: 0 }))).toEqual(['leg-end'])
  })

  test('a banked ledger above a shrunken fold still trips it', () => {
    expect(kinds(beat({ spentUsd: 0 }, { dispatch: [card('t1')] }, { spentUsd: 250 }))).toEqual(['leg-end'])
  })
})
