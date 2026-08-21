/**
 * AN ORDER MAY ONLY EVER NARROW.
 *
 * This is the property the whole artifact rests on: the moment importing a role
 * can buy you a capability you did not already have, an order stops being a
 * description and becomes a privilege-escalation format.
 *
 * Two directions are tested, and the second matters more than the first:
 *   - the trust gate refuses `bypassPermissions` from a non-benevolent caller,
 *   - AND the privilege ladder refuses to lift a narrower base even when the
 *     caller IS benevolent. The trust gate alone does not give you that, which
 *     is exactly the hole `MODE_RANK` exists to close.
 */

import { describe, expect, test } from 'bun:test'
import { ORDER_KIND, type Order, validateOrder } from './order'
import { composeOrderCaps, composeOrderCapsOrThrow, internalOrderCaller, OrderCapsError } from './order-caps'
import type { SpawnCallerContext } from './spawn-permissions'

const order = (over: Record<string, unknown> = {}): Order =>
  validateOrder({
    kind: ORDER_KIND,
    id: 'SEAT@1',
    title: 'A seat',
    seat: 'implementer',
    prompt: 'implementer',
    caps: {},
    ...over,
  })

const BENEVOLENT: SpawnCallerContext = internalOrderCaller('benevolent')
const TRUSTED: SpawnCallerContext = internalOrderCaller('trusted')

describe('permissionMode -- the privilege field', () => {
  test('bypassPermissions from a non-benevolent caller is REFUSED', () => {
    const result = composeOrderCaps(order({ caps: { permissionMode: 'bypassPermissions' } }), {}, TRUSTED)
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.reason).toContain('SEAT@1')
    expect(result.reason).toContain('bypassPermissions mode requires benevolent trust')
    expect(result.field).toBe('permissionMode')
  })

  test('the same order is allowed from a benevolent caller', () => {
    const result = composeOrderCaps(order({ caps: { permissionMode: 'bypassPermissions' } }), {}, BENEVOLENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.permissionMode).toBe('bypassPermissions')
  })

  /**
   * THE HOLE THE TRUST GATE DOES NOT COVER. A benevolent caller running a
   * `dontAsk` base could otherwise be lifted all the way to bypass by an order
   * simply naming it -- the gate would say yes, because the CALLER is allowed
   * bypass. Narrowing has to be a property of the composition, not of the gate.
   */
  test('a benevolent caller with a narrow base is NOT widened by the order', () => {
    const result = composeOrderCaps(
      order({ caps: { permissionMode: 'bypassPermissions' } }),
      { permissionMode: 'dontAsk' },
      BENEVOLENT,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.permissionMode).toBe('dontAsk')
  })

  test('an order NARROWING a wide base is honoured -- that is the point', () => {
    const result = composeOrderCaps(
      order({ caps: { permissionMode: 'plan' } }),
      { permissionMode: 'bypassPermissions' },
      BENEVOLENT,
    )
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.permissionMode).toBe('plan')
  })

  test('an order with no mode leaves the base exactly as it was', () => {
    const result = composeOrderCaps(order(), { permissionMode: 'auto' }, BENEVOLENT)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.permissionMode).toBe('auto')
  })
})

describe('maxBudgetUsd -- the other privilege field', () => {
  test('an order asking for MORE than the base gets the base', () => {
    const result = composeOrderCaps(order({ caps: { maxBudgetUsd: 500 } }), { maxBudgetUsd: 10 }, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.maxBudgetUsd).toBe(10)
  })

  test('an order asking for LESS narrows the base', () => {
    const result = composeOrderCaps(order({ caps: { maxBudgetUsd: 2 } }), { maxBudgetUsd: 10 }, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.maxBudgetUsd).toBe(2)
  })

  test('an absent side is "no opinion", never zero', () => {
    const fromOrder = composeOrderCaps(order({ caps: { maxBudgetUsd: 7 } }), {}, BENEVOLENT)
    const fromBase = composeOrderCaps(order(), { maxBudgetUsd: 7 }, BENEVOLENT)
    const neither = composeOrderCaps(order(), {}, BENEVOLENT)
    if (!fromOrder.ok || !fromBase.ok || !neither.ok) throw new Error('unreachable')
    expect(fromOrder.caps.maxBudgetUsd).toBe(7)
    expect(fromBase.caps.maxBudgetUsd).toBe(7)
    expect(neither.caps.maxBudgetUsd).toBeUndefined()
  })
})

/**
 * THE TURN CEILING composes exactly like the budget, and that is the claim.
 *
 * Both are hard stops on a seat nobody is watching, so both narrow only. If they
 * ever diverge, the divergence is the bug: an order that could RAISE a turn
 * ceiling it was handed would be buying a capability by being imported, which is
 * the one thing this whole module exists to make impossible.
 */
describe('maxTurns -- the second ceiling, narrow-only like the first', () => {
  test('an order asking for MORE turns than the base gets the base', () => {
    const result = composeOrderCaps(order({ caps: { maxTurns: 500 } }), { maxTurns: 10 }, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.maxTurns).toBe(10)
  })

  test('an order asking for FEWER narrows the base', () => {
    const result = composeOrderCaps(order({ caps: { maxTurns: 30 } }), { maxTurns: 200 }, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.maxTurns).toBe(30)
  })

  test('an absent side is "no opinion", never zero -- a zero-turn seat cannot answer', () => {
    const fromOrder = composeOrderCaps(order({ caps: { maxTurns: 30 } }), {}, BENEVOLENT)
    const fromBase = composeOrderCaps(order(), { maxTurns: 30 }, BENEVOLENT)
    const neither = composeOrderCaps(order(), {}, BENEVOLENT)
    if (!fromOrder.ok || !fromBase.ok || !neither.ok) throw new Error('unreachable')
    expect(fromOrder.caps.maxTurns).toBe(30)
    expect(fromBase.caps.maxTurns).toBe(30)
    expect(neither.caps.maxTurns).toBeUndefined()
  })
})

describe('deny -- the capability field, add-only', () => {
  test('the order’s rules are unioned onto the base', () => {
    const result = composeOrderCaps(
      order({ permissions: { deny: ['Bash(git merge:*)'] } }),
      { deny: ['Bash(curl:*)'] },
      BENEVOLENT,
    )
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.deny).toEqual(['Bash(curl:*)', 'Bash(git merge:*)'])
  })

  test('a rule already in the base is not duplicated', () => {
    const result = composeOrderCaps(
      order({ permissions: { deny: ['Bash(curl:*)'] } }),
      { deny: ['Bash(curl:*)'] },
      BENEVOLENT,
    )
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.deny).toEqual(['Bash(curl:*)'])
  })

  test('an order that denies nothing leaves the base untouched -- no empty key', () => {
    const result = composeOrderCaps(order(), {}, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.deny).toBeUndefined()
  })
})

describe('model / effort / agent -- selection, not privilege', () => {
  test('an EXPLICIT base choice wins over the order', () => {
    const result = composeOrderCaps(
      order({ caps: { model: 'claude-haiku-4-5-20251001', effort: 'low', agent: 'a' } }),
      { model: 'claude-opus-5', effort: 'max', agent: 'b' },
      BENEVOLENT,
    )
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps).toMatchObject({ model: 'claude-opus-5', effort: 'max', agent: 'b' })
  })

  test('the order fills a gap the base left', () => {
    const result = composeOrderCaps(order({ caps: { model: 'claude-haiku-4-5-20251001' } }), {}, BENEVOLENT)
    if (!result.ok) throw new Error('unreachable')
    expect(result.caps.model).toBe('claude-haiku-4-5-20251001')
  })
})

describe('composeOrderCapsOrThrow', () => {
  test('throws OrderCapsError on a widening attempt, naming the order', () => {
    expect(() =>
      composeOrderCapsOrThrow(order({ caps: { permissionMode: 'bypassPermissions' } }), {}, TRUSTED),
    ).toThrow(OrderCapsError)
  })

  test('returns the caps when the order stays inside the caller’s trust', () => {
    expect(composeOrderCapsOrThrow(order({ caps: { permissionMode: 'auto' } }), {}, TRUSTED).permissionMode).toBe(
      'auto',
    )
  })

  /** The caller context is the CALLER's. An order has no way to supply one. */
  test('a caller with no spawn permission is refused whatever the order says', () => {
    const caller: SpawnCallerContext = { ...BENEVOLENT, hasSpawnPermission: false }
    expect(() => composeOrderCapsOrThrow(order(), {}, caller)).toThrow(/Spawn permission required/)
  })
})
