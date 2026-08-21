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
import { EPIC_ORDERS, GUARD_ORDER, IMPLEMENTER_ORDER, OVERSEER_ORDER, orderRole, PLANNER_ORDER } from './epic-orders'
import { mayAskHuman } from './epic-run-types'
import { ORDER_KIND, validateOrder } from './order'

const ALL = [OVERSEER_ORDER, PLANNER_ORDER, IMPLEMENTER_ORDER, GUARD_ORDER]

describe('the repo’s own orders are ordinary order@1 artifacts', () => {
  test.each(ALL)('$id revalidates unchanged', order => {
    expect(validateOrder(order)).toEqual(order)
    expect(order.kind).toBe(ORDER_KIND)
  })

  test('every seat the engine can dispatch has exactly one order', () => {
    expect(Object.keys(EPIC_ORDERS).sort()).toEqual(['implementer', 'overseer', 'planner', 'verifier'])
    expect(new Set(ALL.map(o => o.id)).size).toBe(4)
  })

  test('the map and the order agree about which seat it fills', () => {
    for (const [seat, order] of Object.entries(EPIC_ORDERS)) expect(order.seat).toBe(seat as never)
  })
})

describe('the seat -> role map, which decides the mute', () => {
  test('the planner rides the OVERSEER role tag, deliberately', () => {
    expect(orderRole(PLANNER_ORDER)).toBe('overseer')
    expect(PLANNER_ORDER.seat).toBe('planner')
  })

  test('exactly the two overseer-role seats may reach a human', () => {
    expect(ALL.filter(o => mayAskHuman(orderRole(o))).map(o => o.id)).toEqual(['OVERSEER@1', 'PLANNER@1'])
  })

  test('an implementer and a guard report their own roles', () => {
    expect(orderRole(IMPLEMENTER_ORDER)).toBe('implementer')
    expect(orderRole(GUARD_ORDER)).toBe('verifier')
  })
})

describe('worktrees', () => {
  /**
   * ABSENT AND EMPTY ARE DIFFERENT HERE, and conflating them is how the overseer
   * would end up in an isolated checkout that hides the board it exists to judge.
   */
  test('the overseer and the planner get NO worktree at all', () => {
    expect(OVERSEER_ORDER.worktree).toBeUndefined()
    expect(PLANNER_ORDER.worktree).toBeUndefined()
  })

  test('an implementer gets a worktree named for the card, with no prefix', () => {
    expect(IMPLEMENTER_ORDER.worktree).toEqual({ prefix: '' })
  })

  test('a guard gets its OWN scratch worktree, prefixed so it never collides', () => {
    expect(GUARD_ORDER.worktree).toEqual({ prefix: 'verify-' })
    expect(GUARD_ORDER.worktree?.prefix).not.toBe(IMPLEMENTER_ORDER.worktree?.prefix)
  })
})

describe('names and prompts', () => {
  test('the prefixes are the ones the conversation list has always shown', () => {
    expect(OVERSEER_ORDER.namePrefix).toBeUndefined()
    expect(IMPLEMENTER_ORDER.namePrefix).toBeUndefined()
    expect(PLANNER_ORDER.namePrefix).toBe('planner ')
    expect(GUARD_ORDER.namePrefix).toBe('verify ')
  })

  test('each order names a distinct prompt builder', () => {
    expect(ALL.map(o => o.prompt)).toEqual(['overseer', 'planner', 'implementer', 'guard'])
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
    expect(order.caps).toEqual({ permissionMode: 'bypassPermissions' })
  })

  test.each(ALL)('$id adds no deny rules and no raw flags', order => {
    expect(order.permissions).toBeUndefined()
    expect(order.flags).toBeUndefined()
  })
})
