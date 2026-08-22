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
 * THE NO-BEHAVIOUR-CHANGE GUARD, as an assertion rather than a promise.
 *
 * `order@1` can pin a model, an effort tier and a per-seat budget, and none of
 * the four uses any of it -- on purpose. Every one of those would change what
 * the engine spawns, and this card's acceptance test is that it does not. When
 * a later card DOES tune a seat, this test fails and its author has to say which
 * seat and why, in the same commit.
 */
describe('no shipped order changes what the engine emits today', () => {
  test.each(ALL)('$id declares only the permission mode', order => {
    expect(order.caps).toEqual({ permissionMode: 'auto' })
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
