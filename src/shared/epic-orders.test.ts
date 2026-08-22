/**
 * THE FOUR SHIPPED ORDERS.
 *
 * These pin what was hardcoded in `epic-spawn-plan.ts` before it compiled
 * orders: which seat gets a worktree, which gets a name prefix, which role tag
 * it reports, and which prompt builder it uses. The byte-for-byte proof that the
 * COMPILED seat still matches lives in `epic-spawn-plan.test.ts`; these say the
 * declarations the compile reads are the right ones.
 */

import { describe, expect, test } from 'bun:test'
import { clampCardModel } from './card-model'
import {
  EPIC_ORDERS,
  isEpicOrderSeat,
  orderRole,
  orderSeatRole,
  WERK_MASTER_ORDER,
  WERK_PLANNER_ORDER,
  WERK_VERIFIER_ORDER,
  WERK_WORKER_ORDER,
} from './epic-orders'
import { mayAskHuman } from './epic-run-types'
import { ORDER_KIND, validateOrder } from './order'

const ALL = [WERK_MASTER_ORDER, WERK_PLANNER_ORDER, WERK_WORKER_ORDER, WERK_VERIFIER_ORDER]

describe('the repo’s own orders are ordinary order@1 artifacts', () => {
  test.each(ALL)('$id revalidates unchanged', order => {
    expect(validateOrder(order)).toEqual(order)
    expect(order.kind).toBe(ORDER_KIND)
  })

  test('every seat the engine can dispatch has exactly one order', () => {
    expect(Object.keys(EPIC_ORDERS).sort()).toEqual(['werk-master', 'werk-planner', 'werk-verifier', 'werk-worker'])
    expect(new Set(ALL.map(o => o.id)).size).toBe(4)
  })

  test('the map and the order agree about which seat it fills', () => {
    for (const [seat, order] of Object.entries(EPIC_ORDERS)) expect(order.seat).toBe(seat as never)
  })
})

describe('the seat -> role map, which decides the mute', () => {
  test('the werk-planner rides the WERK-MASTER role tag, deliberately', () => {
    expect(orderRole(WERK_PLANNER_ORDER)).toBe('werk-master')
    expect(WERK_PLANNER_ORDER.seat).toBe('werk-planner')
  })

  test('exactly the two werk-master-role seats may reach a human', () => {
    expect(ALL.filter(o => mayAskHuman(orderRole(o))).map(o => o.id)).toEqual(['WERK-MASTER@1', 'WERK-PLANNER@1'])
  })

  test('a werk-worker and a werk-verifier report their own roles', () => {
    expect(orderRole(WERK_WORKER_ORDER)).toBe('werk-worker')
    expect(orderRole(WERK_VERIFIER_ORDER)).toBe('werk-verifier')
  })
})

/**
 * WHERE THE OPEN SCHEMA MEETS THE CLOSED ENGINE.
 *
 * `OrderSeat` is now any lowercase-kebab name, so `SEAT_ROLE[order.seat]` will
 * hand back `undefined` for a seat the engine does not run -- and that
 * `undefined` travels quietly: `buildEpicWorkerSettings(role, ...)` decides the
 * MUTE from the role and `mayAskHuman(undefined)` is falsy, so the seat would be
 * dispatched, muted, and tagged with a role that is not a role. The only place
 * that is cheap to catch is here, with the caller still on the stack.
 */
describe('a seat the epic engine does not dispatch', () => {
  const WERK_REFINER = validateOrder({
    kind: ORDER_KIND,
    id: 'WERK-REFINER@1',
    title: 'WerkRefiner -- drains #needs-refine',
    seat: 'werk-refiner',
    instructions: 'REFINE this card -- do not implement it.',
    caps: {},
  })

  test('is a perfectly legal order@1 -- the SCHEMA is what opened', () => {
    expect(WERK_REFINER.seat).toBe('werk-refiner')
    expect(WERK_REFINER.instructions).toBeTruthy()
  })

  test('orderRole REFUSES it rather than mapping it to undefined', () => {
    expect(() => orderRole(WERK_REFINER)).toThrow(/werk-refiner/)
    expect(() => orderRole(WERK_REFINER)).toThrow(/does not dispatch/)
  })

  test('orderSeatRole is the non-throwing half, for a caller that wants to ASK', () => {
    expect(orderSeatRole('werk-refiner')).toBeUndefined()
    expect(orderSeatRole('werk-planner')).toBe('werk-master')
  })

  test('isEpicOrderSeat answers for the four and nothing else', () => {
    for (const seat of Object.keys(EPIC_ORDERS)) expect(isEpicOrderSeat(seat)).toBe(true)
    for (const seat of ['werk-refiner', 'doc-writer', 'triage', 'toString', 'constructor']) {
      expect(isEpicOrderSeat(seat)).toBe(false)
    }
  })
})

describe('worktrees', () => {
  /**
   * ABSENT AND EMPTY ARE DIFFERENT HERE, and conflating them is how the werk-master
   * would end up in an isolated checkout that hides the board it exists to judge.
   */
  test('the werk-master and the werk-planner get NO worktree at all', () => {
    expect(WERK_MASTER_ORDER.worktree).toBeUndefined()
    expect(WERK_PLANNER_ORDER.worktree).toBeUndefined()
  })

  test('a werk-worker gets a worktree named for the card, with no prefix', () => {
    expect(WERK_WORKER_ORDER.worktree).toEqual({ prefix: '' })
  })

  test('a werk-verifier gets its OWN scratch worktree, prefixed so it never collides', () => {
    expect(WERK_VERIFIER_ORDER.worktree).toEqual({ prefix: 'verify-' })
    expect(WERK_VERIFIER_ORDER.worktree?.prefix).not.toBe(WERK_WORKER_ORDER.worktree?.prefix)
  })
})

describe('names and prompts', () => {
  test('the prefixes are the ones the conversation list has always shown', () => {
    expect(WERK_MASTER_ORDER.namePrefix).toBeUndefined()
    expect(WERK_WORKER_ORDER.namePrefix).toBeUndefined()
    expect(WERK_PLANNER_ORDER.namePrefix).toBe('werk-planner ')
    expect(WERK_VERIFIER_ORDER.namePrefix).toBe('verify ')
  })

  test('each order names a distinct prompt builder', () => {
    expect(ALL.map(o => o.prompt)).toEqual(['werk-master', 'werk-planner', 'werk-worker', 'werk-verifier'])
  })
})

/**
 * WHICH MODEL EACH SEAT SPENDS, as an assertion rather than a settings file.
 *
 * This block used to say the opposite -- "no shipped order changes what the
 * engine emits today", pinning `caps` to the permission mode alone -- and it
 * named its own successor: "when a later card DOES tune a seat, this test fails
 * and its author has to say which seat and why, in the same commit."
 * `werk-seat-model-policy` is that card and this is that saying.
 *
 * THE POINT IS THE ABSENCE OF ABSENCES. An unset `model` does not mean "the
 * ordinary tier", it means the seat resolves to whatever a machine's spawn
 * default happens to be -- a value no commit records and no resolver can read.
 * So the first test below is the one that matters: every seat declares both,
 * including the two that want the ordinary tier.
 */
describe('every seat declares the model and the effort it spends', () => {
  test.each(ALL)('$id leaves neither to the spawn default', order => {
    expect(order.caps.model).toBeTruthy()
    expect(order.caps.effort).toBeTruthy()
  })

  /**
   * PINNED, and pinned separately from the ordinary tier below. The werk-master
   * holds the plan of record, decides what dispatches and is the sole writer of
   * `done`; the werk-planner writes the dependency graph the whole run is
   * arithmetic over. One seat per beat, and the most expensive place in the
   * system to be wrong.
   */
  test.each([WERK_MASTER_ORDER, WERK_PLANNER_ORDER])('$id is pinned to opus at max effort', order => {
    expect(order.caps.model).toBe('opus')
    expect(order.caps.effort).toBe('max')
  })

  /**
   * The ordinary tier -- ONE value, shared, so "the default" is a single fact.
   * It is also the CEILING `clampCardModel` clamps a card's hint to, which is
   * why it is not something cheaper: a lower ceiling would foreclose the case
   * `werk-seat-model-per-project` exists to serve.
   */
  test('the werk-worker and the werk-verifier share one ordinary tier', () => {
    expect(WERK_WORKER_ORDER.caps.model).toBe(WERK_VERIFIER_ORDER.caps.model)
    expect(WERK_WORKER_ORDER.caps.effort).toBe(WERK_VERIFIER_ORDER.caps.effort)
    expect(WERK_WORKER_ORDER.caps.model).toBe('opus')
    expect(WERK_WORKER_ORDER.caps.effort).toBe('high')
  })

  /**
   * A card may narrow its seat and may never widen it -- the ordering
   * `card-model.ts` owns, asserted here against the REAL cap rather than a
   * literal, so it keeps meaning the same thing if the tier is retuned.
   */
  test('a card can spend less than the werk-worker seat, never more', () => {
    const cap = WERK_WORKER_ORDER.caps.model
    expect(clampCardModel('haiku', cap).model).toBe('haiku')
    expect(clampCardModel('fable', cap).model).toBe(cap)
    expect(clampCardModel('fable', cap).note).toContain('asks for more than')
  })

  /** Nobody may talk a lead seat down. */
  test('a card cannot talk a werk-master down to haiku', () => {
    expect(clampCardModel('haiku', WERK_MASTER_ORDER.caps.model).model).toBe('haiku')
    expect(WERK_MASTER_ORDER.caps.model).toBe('opus')
  })

  test.each(ALL)('$id still runs at the `auto` permission mode', order => {
    expect(order.caps.permissionMode).toBe('auto')
  })

  /**
   * PER-SEAT BUDGET AND TURN CEILING STAY ABSENT, and that absence is still a
   * decision: `werk-run-caps` bounds the RUN, and a per-seat bound on a job
   * nobody has sized yet is a number invented rather than measured.
   */
  test.each(ALL)('$id sets no per-seat budget or turn ceiling', order => {
    expect(order.caps.maxBudgetUsd).toBeUndefined()
    expect(order.caps.maxTurns).toBeUndefined()
    expect(order.caps.agent).toBeUndefined()
    expect(order.caps.mcpConfigPath).toBeUndefined()
  })

  /**
   * The gate on WHO may dispatch a fleet seat, asserted separately from the
   * privilege the seat runs at -- because it used not to be. It rode on the
   * seats naming `bypassPermissions`, so narrowing them to `auto` would have
   * dropped it silently. If a future edit relaxes the mode again, this still
   * fails on its own.
   */
  test.each(ALL)('$id may only be dispatched by a benevolent caller', order => {
    expect(order.minTrust).toBe('benevolent')
  })

  test.each(ALL)('$id adds no deny rules and no raw flags', order => {
    expect(order.permissions).toBeUndefined()
    expect(order.flags).toBeUndefined()
  })
})
