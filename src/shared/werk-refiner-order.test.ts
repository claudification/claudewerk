/**
 * WERK-REFINER@1 -- the seat, its caps, and the two things a werk-refiner must get right.
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
import { taskMode } from './task-modes'
import { seatOrder, WERK_REFINER_INSTRUCTIONS, WERK_REFINER_ORDER, WERK_REFINER_ORDER_ID } from './werk-refiner-order'

describe('WERK-REFINER@1, the artifact', () => {
  test('is a legal order@1 -- the repo does not exempt its own orders from the validator', () => {
    // Round-tripping proves the exported constant is what the validator emits,
    // not a literal that merely happens to type-check.
    expect(validateOrder(WERK_REFINER_ORDER)).toEqual(WERK_REFINER_ORDER)
    expect(WERK_REFINER_ORDER.id).toBe(WERK_REFINER_ORDER_ID)
  })

  test('carries its own caps -- a werk-refiner does not run on the fleet default', () => {
    expect(WERK_REFINER_ORDER.caps.model).toBe('claude-haiku-4-5')
    expect(WERK_REFINER_ORDER.caps.effort).toBe('low')
    expect(WERK_REFINER_ORDER.caps.maxBudgetUsd).toBe(0.5)
    // ON THE ORDER NOW, not on a wrapper beside it. `order@1` grew both of the
    // caps this seat used to carry outside the schema.
    expect(WERK_REFINER_ORDER.caps.maxTurns).toBe(30)
    expect(WERK_REFINER_ORDER.reservation).toBe(1)
  })

  test('gets no worktree -- the board lives in the main checkout', () => {
    expect(WERK_REFINER_ORDER.worktree).toBeUndefined()
  })

  test('cannot flip a status, mechanically and not just in prose', () => {
    expect(WERK_REFINER_ORDER.permissions?.deny).toContain('mcp__rclaude__project_set_status')
  })

  test('its instructions tell the seat to leave the status alone and not to implement', () => {
    const text = WERK_REFINER_ORDER.instructions ?? ''
    expect(text).toContain("Do NOT change the card's status")
    expect(text).toContain('do NOT start implementing')
  })

  /**
   * THE DRAIN IS THE ENGINE'S, AND THIS IS WHAT KEEPS IT THAT WAY.
   *
   * The block used to carry "REMOVE the `needs-refine` tag" as step 7, and a
   * werk-refiner killed at step 6 therefore left the queue entry on the board
   * forever. `tag-clear.ts` clears it now, on evidence the refine landed, and an
   * instruction putting the seat back in charge of the same write would be a
   * second mechanism -- one that fires on the seat's exit, which is precisely the
   * timing `werk-tag-cleared-by-evidence` rejects.
   */
  test('its instructions do NOT ask the seat to drain the tag', () => {
    const text = WERK_REFINER_ORDER.instructions ?? ''
    expect(text).not.toContain('needs-refine')
    expect(text.toLowerCase()).not.toContain('remove')
  })

  /**
   * A werk-refiner reached from the LAUNCH modal runs `TASK_MODES.refine.single`; one
   * reached from this seat runs `WERK_REFINER_ORDER.instructions`. A hint only one of
   * them asks for is a hint that appears or vanishes depending on which door the
   * refine came through, which is the drift `task-modes.ts` exists to record.
   *
   * READ OFF THE ORDER. There is no seat wrapper left to read off:
   * `order-seat-union-is-closed` moved `instructions` from `SeatOrder` onto the
   * `Order`, and `order-caps-turns-and-reservation` then deleted the `WERK-REFINER`
   * wrapper outright once `maxTurns` and `reservation` followed it. Both of the
   * assertions below used to read `WERK-REFINER.instructions`, which resolved to
   * `undefined` -- and `toContain` THROWS on `undefined` rather than failing, so
   * they would have gone quiet instead of red.
   */
  test('BOTH copies of the refine prose ask for a `model:` suggestion', () => {
    const refine = taskMode('refine')
    for (const text of [WERK_REFINER_ORDER.instructions, refine.single, refine.instructions]) {
      expect(text).toContain('model:')
    }
  })

  test('the seat prose says the hint is a hint -- an order may clamp it', () => {
    expect(WERK_REFINER_ORDER.instructions).toContain('clamp')
  })

  test('is reachable by id, and an unknown id is absent rather than an error', () => {
    expect(seatOrder(WERK_REFINER_ORDER_ID)).toBe(WERK_REFINER_ORDER)
    expect(seatOrder('NOPE@1')).toBeUndefined()
    expect(seatOrder(undefined)).toBeUndefined()
  })
})

/**
 * THE MISLABEL, GONE -- and the refusal that has to come with it.
 *
 * `WERK-REFINER@1` shipped as `seat: 'werk-worker', prompt: 'werk-worker'` because
 * `order@1` had no other true thing to say. Declaring `seat: 'werk-refiner'` is only
 * half the fix: an open seat name with nothing refusing it is just a wider
 * string, and the failure it prevents is specific -- `orderRole` feeding
 * `undefined` into `buildEpicWorkerSettings`, which reads the MUTE off the role,
 * so a werk-refiner compiled into a generation would be dispatched, silently muted
 * and tagged with a role that is not one.
 */
describe('a werk-refiner is spent by the scheduler and never enters a generation', () => {
  test('it declares the seat it actually fills', () => {
    expect(WERK_REFINER_ORDER.seat).toBe('werk-refiner')
  })

  test('it names no prompt builder -- the four compile a CARD into an epic seat', () => {
    expect(WERK_REFINER_ORDER.prompt).toBeUndefined()
  })

  test('it carries its own instruction block, on the order rather than beside it', () => {
    expect(WERK_REFINER_ORDER.instructions).toBe(WERK_REFINER_INSTRUCTIONS)
  })

  test('orderRole REFUSES it rather than mapping it to undefined', () => {
    expect(() => orderRole(WERK_REFINER_ORDER)).toThrow(/werk-refiner/)
    expect(() => orderRole(WERK_REFINER_ORDER)).toThrow(/does not dispatch/)
  })
})

describe('WERK-REFINER@1 may only ever NARROW the trust of whoever runs it', () => {
  test('a caller already narrower than the order keeps its own mode', () => {
    const result = composeOrderCaps(WERK_REFINER_ORDER, { permissionMode: 'plan' }, internalOrderCaller())
    expect(result.ok).toBe(true)
    // The order names bypassPermissions; the base named plan; plan wins.
    if (result.ok) expect(result.caps.permissionMode).toBe('plan')
  })

  test('a non-benevolent caller is REFUSED, not silently downgraded', () => {
    const result = composeOrderCaps(WERK_REFINER_ORDER, {}, internalOrderCaller('trusted'))
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toContain(WERK_REFINER_ORDER_ID)
  })

  test('a smaller budget on the caller wins over the order', () => {
    const result = composeOrderCaps(WERK_REFINER_ORDER, { maxBudgetUsd: 0.1 }, internalOrderCaller())
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.caps.maxBudgetUsd).toBe(0.1)
  })

  test('the order supplies the model when the caller has no opinion, and yields when it does', () => {
    const blank = composeOrderCaps(WERK_REFINER_ORDER, {}, internalOrderCaller())
    expect(blank.ok && blank.caps.model).toBe('claude-haiku-4-5')
    const explicit = composeOrderCaps(WERK_REFINER_ORDER, { model: 'claude-opus-5' }, internalOrderCaller())
    expect(explicit.ok && explicit.caps.model).toBe('claude-opus-5')
  })

  test('the deny rule survives composition -- it is the half an order may add', () => {
    const result = composeOrderCaps(WERK_REFINER_ORDER, { deny: ['Bash(rm:*)'] }, internalOrderCaller())
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.caps.deny).toContain('Bash(rm:*)')
      expect(result.caps.deny).toContain('mcp__rclaude__project_set_status')
    }
  })
})
