/**
 * THE SEAM WHERE A CAP BECOMES A FLAG.
 *
 * The point of `order-caps-turns-and-reservation` is that `WERK-REFINER@1` shipped a
 * `maxTurns: 30` that nothing downstream read -- a cap declared on a wrapper
 * type, validated by nobody, spent by nobody. So the assertion that matters is
 * not "the order has the field" (that is `order.test.ts`) but "the number
 * reaches an argv", which is here.
 *
 * The flag NAME is checked against a literal on purpose. `--max-turns` is hidden
 * from `claude --help`, so nothing else in this repo would notice a typo until a
 * spawn died with `error: unknown option` in a launch log nobody reads.
 */

import { describe, expect, test } from 'bun:test'
import { WERK_REFINER_ORDER } from '../shared/werk-refiner-order'
import { buildHeadlessArgs } from './headless-args'

/** The value that follows `flag`, or undefined if the flag is absent. */
function flagValue(args: string[], flag: string): string | undefined {
  const at = args.indexOf(flag)
  return at === -1 ? undefined : args[at + 1]
}

describe('the two ceilings reach the command line', () => {
  test('a turn cap becomes --max-turns', () => {
    expect(flagValue(buildHeadlessArgs({ maxTurns: 30 }), '--max-turns')).toBe('30')
  })

  test('no turn cap means NO flag -- absent is not zero, and CC has its own default', () => {
    expect(buildHeadlessArgs({}).includes('--max-turns')).toBe(false)
    // Guarding on truthiness also drops a 0 that slipped past validation, which
    // is the right direction: an unbounded seat beats a seat that cannot take
    // its first turn and then looks like a crashed spawn.
    expect(buildHeadlessArgs({ maxTurns: 0 }).includes('--max-turns')).toBe(false)
  })

  test('the budget and the turn ceiling ride together, both narrowing the same seat', () => {
    const args = buildHeadlessArgs({ maxBudgetUsd: 0.5, maxTurns: 30 })
    expect(flagValue(args, '--max-budget-usd')).toBe('0.5')
    expect(flagValue(args, '--max-turns')).toBe('30')
  })

  /**
   * The end of the chain the card exists to close: the ORDER's number, not a
   * number this test picked. If `WERK-REFINER@1`'s cap moves, this moves with it; if
   * the cap stops reaching the argv, this fails.
   */
  test("WERK-REFINER@1's declared cap is the one that lands on the line", () => {
    const turns = WERK_REFINER_ORDER.caps.maxTurns
    expect(turns).toBeDefined()
    expect(flagValue(buildHeadlessArgs({ maxTurns: turns }), '--max-turns')).toBe(String(turns))
  })
})

describe('the flags that were already there still behave', () => {
  test('an unattended-GUARDED mode omits the bypass flag, and still gets its caps', () => {
    const args = buildHeadlessArgs({ permissionMode: 'dontAsk', maxTurns: 5 })
    expect(args.includes('--dangerously-skip-permissions')).toBe(false)
    expect(flagValue(args, '--max-turns')).toBe('5')
  })

  test('every other mode keeps the legacy bypass', () => {
    expect(buildHeadlessArgs({ permissionMode: 'bypassPermissions' })[0]).toBe('--dangerously-skip-permissions')
    expect(buildHeadlessArgs({})[0]).toBe('--dangerously-skip-permissions')
  })

  test('a resume names the session, a fresh spawn does not', () => {
    expect(flagValue(buildHeadlessArgs({ mode: 'resume', resumeId: 'abc' }), '--resume')).toBe('abc')
    expect(flagValue(buildHeadlessArgs({ mode: 'resume', resumeName: 'named' }), '--resume')).toBe('named')
    expect(buildHeadlessArgs({ mode: 'fresh', resumeId: 'abc' }).includes('--resume')).toBe(false)
  })
})
