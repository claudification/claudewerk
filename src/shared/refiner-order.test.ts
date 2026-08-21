/**
 * REFINER@1 -- the seat, its caps, and the two things a refiner must get right.
 *
 * The interesting assertions are not "the object has these fields". They are the
 * PROPERTIES the card is about: the order goes through the same validator a
 * stranger's order would, it can only ever narrow the trust of whoever runs it,
 * and its instructions cannot quietly lose the tag removal or grow a status flip.
 */

import { describe, expect, test } from 'bun:test'
import { orderRole } from './epic-orders'
import { validateOrder } from './order'
import { composeOrderCaps, internalOrderCaller } from './order-caps'
import { REFINER_INSTRUCTIONS, REFINER_ORDER, REFINER_ORDER_ID, seatOrder } from './refiner-order'

describe('REFINER@1, the artifact', () => {
  test('is a legal order@1 -- the repo does not exempt its own orders from the validator', () => {
    // Round-tripping proves the exported constant is what the validator emits,
    // not a literal that merely happens to type-check.
    expect(validateOrder(REFINER_ORDER)).toEqual(REFINER_ORDER)
    expect(REFINER_ORDER.id).toBe(REFINER_ORDER_ID)
  })

  test('carries its own caps -- a refiner does not run on the fleet default', () => {
    expect(REFINER_ORDER.caps.model).toBe('claude-haiku-4-5')
    expect(REFINER_ORDER.caps.effort).toBe('low')
    expect(REFINER_ORDER.caps.maxBudgetUsd).toBe(0.5)
    // ON THE ORDER NOW, not on a wrapper beside it. `order@1` grew both of the
    // caps this seat used to carry outside the schema.
    expect(REFINER_ORDER.caps.maxTurns).toBe(30)
    expect(REFINER_ORDER.reservation).toBe(1)
  })

  test('gets no worktree -- the board lives in the main checkout', () => {
    expect(REFINER_ORDER.worktree).toBeUndefined()
  })

  test('cannot flip a status, mechanically and not just in prose', () => {
    expect(REFINER_ORDER.permissions?.deny).toContain('mcp__rclaude__project_set_status')
  })

  test('its instructions tell the seat to drain the tag and leave the status alone', () => {
    const text = REFINER_ORDER.instructions ?? ''
    expect(text).toContain('needs-refine')
    expect(text.toLowerCase()).toContain('remove')
    expect(text).toContain("Do NOT change the card's status")
    expect(text).toContain('do NOT start implementing')
  })

  test('is reachable by id, and an unknown id is absent rather than an error', () => {
    expect(seatOrder(REFINER_ORDER_ID)).toBe(REFINER_ORDER)
    expect(seatOrder('NOPE@1')).toBeUndefined()
    expect(seatOrder(undefined)).toBeUndefined()
  })
})

/**
 * THE MISLABEL, GONE -- and the refusal that has to come with it.
 *
 * `REFINER@1` shipped as `seat: 'implementer', prompt: 'implementer'` because
 * `order@1` had no other true thing to say. Declaring `seat: 'refiner'` is only
 * half the fix: an open seat name with nothing refusing it is just a wider
 * string, and the failure it prevents is specific -- `orderRole` feeding
 * `undefined` into `buildEpicWorkerSettings`, which reads the MUTE off the role,
 * so a refiner compiled into a generation would be dispatched, silently muted
 * and tagged with a role that is not one.
 */
describe('a refiner is spent by the scheduler and never enters a generation', () => {
  test('it declares the seat it actually fills', () => {
    expect(REFINER_ORDER.seat).toBe('refiner')
  })

  test('it names no prompt builder -- the four compile a CARD into an epic seat', () => {
    expect(REFINER_ORDER.prompt).toBeUndefined()
  })

  test('it carries its own instruction block, on the order rather than beside it', () => {
    expect(REFINER_ORDER.instructions).toBe(REFINER_INSTRUCTIONS)
  })

  test('orderRole REFUSES it rather than mapping it to undefined', () => {
    expect(() => orderRole(REFINER_ORDER)).toThrow(/refiner/)
    expect(() => orderRole(REFINER_ORDER)).toThrow(/does not dispatch/)
  })
})

describe('REFINER@1 may only ever NARROW the trust of whoever runs it', () => {
  test('a caller already narrower than the order keeps its own mode', () => {
    const result = composeOrderCaps(REFINER_ORDER, { permissionMode: 'plan' }, internalOrderCaller())
    expect(result.ok).toBe(true)
    // The order names bypassPermissions; the base named plan; plan wins.
    if (result.ok) expect(result.caps.permissionMode).toBe('plan')
  })

  test('a non-benevolent caller is REFUSED, not silently downgraded', () => {
    const result = composeOrderCaps(REFINER_ORDER, {}, internalOrderCaller('trusted'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(REFINER_ORDER_ID)
  })

  test('a smaller budget on the caller wins over the order', () => {
    const result = composeOrderCaps(REFINER_ORDER, { maxBudgetUsd: 0.1 }, internalOrderCaller())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.caps.maxBudgetUsd).toBe(0.1)
  })

  test('the order supplies the model when the caller has no opinion, and yields when it does', () => {
    const blank = composeOrderCaps(REFINER_ORDER, {}, internalOrderCaller())
    expect(blank.ok && blank.caps.model).toBe('claude-haiku-4-5')
    const explicit = composeOrderCaps(REFINER_ORDER, { model: 'claude-opus-5' }, internalOrderCaller())
    expect(explicit.ok && explicit.caps.model).toBe('claude-opus-5')
  })

  test('the deny rule survives composition -- it is the half an order may add', () => {
    const result = composeOrderCaps(REFINER_ORDER, { deny: ['Bash(rm:*)'] }, internalOrderCaller())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.caps.deny).toContain('Bash(rm:*)')
      expect(result.caps.deny).toContain('mcp__rclaude__project_set_status')
    }
  })
})
