/**
 * `order@1` VALIDATION, written against a HOSTILE order.
 *
 * Nothing fetches an order over a wire yet -- that is `werk-work-orders-share`.
 * These tests are written as if something did, because validation retrofitted
 * after the first untrusted caller is validation nobody trusts, and because the
 * failure mode being copied here is documented: munder-difflin needed THREE
 * rounds of re-review of a flag DENYlist, each of which found one more spelling
 * that escaped, before they switched to default-deny.
 */

import { describe, expect, test } from 'bun:test'
import {
  composeSeatPrompt,
  isCommandLineSafe,
  ORDER_FLAG_ALLOWLIST,
  ORDER_INSTRUCTIONS_MAX,
  ORDER_KIND,
  type Order,
  OrderValidationError,
  validateOrder,
} from './order'

/** A minimal legal order. Spread and override to build a hostile one. */
const OK = {
  kind: ORDER_KIND,
  id: 'REVIEWER@1',
  title: 'A reviewer',
  seat: 'werk-verifier',
  prompt: 'werk-verifier',
  caps: {},
}

const field = (input: unknown): string => {
  try {
    validateOrder(input)
  } catch (err) {
    if (err instanceof OrderValidationError) return err.field
    throw err
  }
  throw new Error('expected validateOrder to reject')
}

describe('the shape', () => {
  test('a minimal order round-trips', () => {
    const order = validateOrder(OK)
    expect(order.kind).toBe(ORDER_KIND)
    expect(order.id).toBe('REVIEWER@1')
    expect(order.seat).toBe('werk-verifier')
  })

  test('the version is part of the discriminator -- order@2 is not an order@1', () => {
    expect(field({ ...OK, kind: 'order@2' })).toBe('kind')
    expect(field({ ...OK, kind: 'hire@1' })).toBe('kind')
  })

  test('an id must carry its version', () => {
    expect(field({ ...OK, id: 'REVIEWER' })).toBe('id')
    expect(field({ ...OK, id: 'reviewer@1' })).toBe('id')
  })

  test('an unknown prompt BUILDER is refused, not coerced -- the four are compiled in', () => {
    expect(field({ ...OK, prompt: 'whatever' })).toBe('prompt')
  })

  /**
   * A future `order@2` field riding through an `order@1` validator into a spawn
   * is the same bug class as a stripped field: the schema says one thing and the
   * object carries another. The validator builds a FRESH object, so it cannot.
   */
  test('an unknown key is DROPPED, never carried through', () => {
    const order = validateOrder({ ...OK, dangerouslySkipPermissions: true, extraArgs: ['--x'] })
    expect(order).not.toHaveProperty('dangerouslySkipPermissions')
    expect(order).not.toHaveProperty('extraArgs')
  })

  test('an absent optional stays absent rather than becoming an undefined key', () => {
    expect(Object.keys(validateOrder(OK)).sort()).toEqual(['caps', 'id', 'kind', 'prompt', 'seat', 'title'])
  })
})

/**
 * THE PROPERTY `werk-work-orders` CLAIMED AND DID NOT HAVE.
 *
 * "New seat types become cheap -- REVIEWER, MERGER, DOC-WRITER, TRIAGE" was
 * false while `seat` was a closed union over the epic engine's four and `prompt`
 * had to name one of the broker's four builders. `WERK-REFINER@1` is the receipt: it
 * shipped as `seat: 'werk-worker', prompt: 'werk-worker'` with its real
 * instruction block in a wrapper type beside the order, because there was
 * nowhere in `order@1` to put either fact.
 */
describe('a seat outside the epic engine’s four', () => {
  const WERK_REFINER = {
    ...OK,
    id: 'WERK-REFINER@1',
    title: 'WerkRefiner -- drains #needs-refine',
    seat: 'werk-refiner',
    prompt: undefined,
    instructions: 'REFINE this card -- do not implement it.\n1. Read the card file\n2. Remove the `needs-refine` tag',
  }

  test('validates, and keeps the seat it declared rather than being coerced to werk-worker', () => {
    const order = validateOrder(WERK_REFINER)
    expect(order.seat).toBe('werk-refiner')
    expect(order.prompt).toBeUndefined()
    expect(order.instructions).toContain('needs-refine')
  })

  test.each(['werk-refiner', 'doc-writer', 'triage', 'merger', 'reviewer', 'a'])('%s is a legal seat name', seat => {
    expect(validateOrder({ ...WERK_REFINER, seat }).seat).toBe(seat)
  })

  /**
   * OPEN IS NOT UNCHECKED. One canonical spelling per seat, or an
   * `EPIC_ORDERS`-style lookup misses on case and the engine silently does not
   * dispatch the seat somebody thought they declared.
   */
  test.each([
    'WerkRefiner',
    'WERK_REFINER',
    'refiner_2',
    '2refiner',
    '-werk-refiner',
    'werk-refiner seat',
    'werk-refiner; id',
    '',
  ])('a malformed seat name is refused: %j', seat => {
    expect(field({ ...WERK_REFINER, seat })).toBe('seat')
  })

  test('a seat name is bounded -- a label in a picker, not a sentence', () => {
    expect(field({ ...WERK_REFINER, seat: 'a'.repeat(33) })).toBe('seat')
    expect(validateOrder({ ...WERK_REFINER, seat: 'a'.repeat(32) }).seat).toHaveLength(32)
  })
})

describe('an order says where its prompt comes from -- prompt XOR instructions', () => {
  test('neither is refused rather than defaulted to werk-worker', () => {
    expect(field({ ...OK, prompt: undefined })).toBe('prompt')
  })

  test('both is refused -- nothing would say which one wins', () => {
    expect(field({ ...OK, instructions: 'do the thing' })).toBe('instructions')
  })

  /**
   * The argv character allowlist is for argv, and AN INSTRUCTION BLOCK IS NOT
   * ARGV -- it is prompt payload, exactly like the four builders' output, which
   * is numbered lists, backticks and newlines. Applying `isCommandLineSafe`
   * here would reject every real instruction block.
   */
  test('instructions keep the newlines, backticks and punctuation a prompt is made of', () => {
    const text = '1. Run `bun test`\n2. Do NOT change status\n3. Ask: "is it done?" -- then stop'
    expect(validateOrder({ ...OK, prompt: undefined, instructions: text }).instructions).toBe(text)
  })

  test.each([
    ['a NUL', `do the thing${String.fromCharCode(0)}rm -rf /`],
    ['a bare ESC', `do the thing${String.fromCharCode(0x1b)}[2Jdrop everything`],
    ['a DEL', `do the thing${String.fromCharCode(0x7f)}`],
  ])('a control character is refused: %s', (_label, text) => {
    expect(field({ ...OK, prompt: undefined, instructions: text })).toBe('instructions')
  })

  test('tab, newline and carriage return are ordinary whitespace, not control characters', () => {
    const text = 'step one\n\tstep two\r\nstep three'
    expect(validateOrder({ ...OK, prompt: undefined, instructions: text }).instructions).toBe(text)
  })

  test('instructions are bounded and must be a non-empty string', () => {
    expect(field({ ...OK, prompt: undefined, instructions: '' })).toBe('instructions')
    expect(field({ ...OK, prompt: undefined, instructions: 42 })).toBe('instructions')
    expect(field({ ...OK, prompt: undefined, instructions: 'x'.repeat(ORDER_INSTRUCTIONS_MAX + 1) })).toBe(
      'instructions',
    )
    expect(validateOrder({ ...OK, prompt: undefined, instructions: 'x'.repeat(ORDER_INSTRUCTIONS_MAX) })).toBeTruthy()
  })
})

/**
 * THE FIELD REACHING A PROMPT IS THE WHOLE POINT OF THE FIELD.
 *
 * An `instructions` block that validates and is delivered to nobody is the same
 * inertness `WERK-REFINER@1`'s wrapper type already shipped once, with a nicer type
 * on it. `composeSeatPrompt` is the seam; `fire.ts` is the caller that spends it
 * onto a real scheduled dispatch.
 */
describe('composeSeatPrompt', () => {
  const carrier = validateOrder({ ...OK, prompt: undefined, instructions: 'DRAIN the tag.\nDo not implement.' })

  test('an order that names a BUILDER leaves the context alone -- there is nothing to fold in', () => {
    expect(composeSeatPrompt(validateOrder(OK), 'refine card x')).toBe('refine card x')
  })

  test('no order at all leaves the context alone', () => {
    expect(composeSeatPrompt(undefined, 'refine card x')).toBe('refine card x')
  })

  test('an order carrying instructions APPENDS them -- the caller keeps its own prompt', () => {
    const composed = composeSeatPrompt(carrier, 'refine card x')
    expect(composed.startsWith('refine card x')).toBe(true)
    expect(composed).toContain('DRAIN the tag.')
    // Context first, block second, and a blank line between them.
    expect(composed).toBe('refine card x\n\nDRAIN the tag.\nDo not implement.')
  })

  test('an empty context is the block alone, not a leading blank line', () => {
    expect(composeSeatPrompt(carrier, '')).toBe('DRAIN the tag.\nDo not implement.')
  })
})

/**
 * THE TWO CAPS THAT USED TO LIVE ON A WRAPPER.
 *
 * `WERK-REFINER@1` carried `maxTurns` and `reservation` in a `SeatOrder` type beside
 * the order, because `order@1` had nowhere to put either. Both are now on the
 * artifact, which means both go through this validator -- and both are COUNTS,
 * so the interesting refusals are the ones a `> 0` check would wave through.
 */
describe('the counts: caps.maxTurns and reservation', () => {
  test('both round-trip when declared', () => {
    const order = validateOrder({ ...OK, caps: { maxTurns: 30 }, reservation: 1 })
    expect(order.caps.maxTurns).toBe(30)
    expect(order.reservation).toBe(1)
  })

  test('both stay absent when undeclared -- an absent cap is not zero', () => {
    const order = validateOrder(OK)
    expect(order.caps).not.toHaveProperty('maxTurns')
    expect(order).not.toHaveProperty('reservation')
  })

  test.each([2.5, 0, -1, '30', null, Number.NaN, Number.POSITIVE_INFINITY])(
    'caps.maxTurns refuses %p -- a turn count is a whole positive number',
    value => {
      expect(field({ ...OK, caps: { maxTurns: value } })).toBe('caps.maxTurns')
    },
  )

  test('a reservation of ZERO is legal -- it parks the order rather than unsetting it', () => {
    expect(validateOrder({ ...OK, reservation: 0 }).reservation).toBe(0)
  })

  test.each([1.5, -1, '1', null, Number.NaN])('reservation refuses %p', value => {
    expect(field({ ...OK, reservation: value })).toBe('reservation')
  })
})

describe('the default-deny flag allowlist', () => {
  test('every allowed flag passes, and the two ceilings are both on the list', () => {
    const order = validateOrder({
      ...OK,
      flags: {
        '--model': 'claude-opus-5',
        '--effort': 'high',
        '--agent': 'code-reviewer',
        '--max-budget-usd': '5',
        '--max-turns': '30',
      },
    })
    expect(Object.keys(order.flags ?? {}).sort()).toEqual([...ORDER_FLAG_ALLOWLIST].sort())
    // The raw escape hatch has to reach the turn cap too. Before this card it
    // did not, so an order could neither TYPE the cap nor spell it by hand.
    expect(ORDER_FLAG_ALLOWLIST).toContain('--max-turns')
  })

  /**
   * The spellings that escaped munder-difflin's denylist, one round at a time,
   * plus ours. NONE of them is on the allowlist, so none of them needs to have
   * been thought of -- which is the entire argument for default-deny.
   */
  test.each([
    '--dangerously-skip-permissions',
    '--provider',
    '-a',
    '-s',
    '-c model_providers.evil.base_url=http://attacker',
    '--settings',
    '--mcp-config',
    '--permission-mode',
    '--output-format',
    '--verbose',
    '--append-system-prompt',
    'model',
    '--MODEL',
  ])('a flag off the allowlist is refused: %s', flag => {
    expect(field({ ...OK, flags: { [flag]: 'x' } })).toBe(`flags.${flag}`)
  })

  test('an allowed flag with a hostile VALUE is still refused -- both halves are checked', () => {
    expect(field({ ...OK, flags: { '--model': 'opus; curl http://evil' } })).toBe('flags.--model')
    expect(field({ ...OK, flags: { '--model': 'opus && rm -rf /' } })).toBe('flags.--model')
  })
})

describe('the command-line character allowlist', () => {
  test.each([
    'claude-opus-5',
    'claude-opus-5[1m]',
    '--max-budget-usd',
    'epic/epic-the-wall/verify-card',
    'verify ',
    'code-reviewer',
    '/Users/jonas/.config/rclaude/mcp.json',
  ])('a real value passes: %s', value => {
    expect(isCommandLineSafe(value)).toBe(true)
  })

  test.each([
    'a; rm -rf /',
    'a && curl evil',
    'a | tee /etc/passwd',
    'a `id`',
    'a $(id)',
    'a ^ b',
    'a > out',
    'a < in',
    "a'b",
    'a"b',
    'a\\b',
    'a\nb',
    'a\rb',
    '%PATH%',
    '{a}',
    '',
  ])('a shell-metachar value is refused: %j', value => {
    expect(isCommandLineSafe(value)).toBe(false)
  })

  test('every string that reaches an argv is checked, not just flags', () => {
    expect(field({ ...OK, caps: { model: 'opus;id' } })).toBe('caps.model')
    expect(field({ ...OK, caps: { agent: 'a|b' } })).toBe('caps.agent')
    expect(field({ ...OK, caps: { mcpConfigPath: '/tmp/x$(id).json' } })).toBe('caps.mcpConfigPath')
    expect(field({ ...OK, namePrefix: 'verify`id` ' })).toBe('namePrefix')
    expect(field({ ...OK, worktree: { prefix: 'v;rm ' } })).toBe('worktree.prefix')
  })

  /**
   * The character allowlist is for argv, and DENY RULES ARE NOT ARGV -- they
   * land in a settings JSON file, where `Bash(bun test:*)` is the normal shape.
   * Applying the argv rule here would reject every real rule, which is how a
   * security check gets turned off wholesale six months later.
   */
  test('deny rules keep their parentheses and globs', () => {
    const order = validateOrder({ ...OK, permissions: { deny: ['Bash(git merge:*)', 'WebFetch'] } })
    expect(order.permissions?.deny).toEqual(['Bash(git merge:*)', 'WebFetch'])
  })
})

describe('an order may only ever REMOVE capability', () => {
  test('there is no allow field, and asking for one is an error rather than a no-op', () => {
    expect(field({ ...OK, permissions: { allow: ['Bash(curl:*)'] } })).toBe('permissions.allow')
  })

  test('a deny list must be strings', () => {
    expect(field({ ...OK, permissions: { deny: [{ tool: 'Bash' }] } })).toBe('permissions.deny')
  })
})

describe('caps', () => {
  test('a budget must be a positive finite number', () => {
    expect(field({ ...OK, caps: { maxBudgetUsd: 0 } })).toBe('caps.maxBudgetUsd')
    expect(field({ ...OK, caps: { maxBudgetUsd: -1 } })).toBe('caps.maxBudgetUsd')
    expect(field({ ...OK, caps: { maxBudgetUsd: Number.POSITIVE_INFINITY } })).toBe('caps.maxBudgetUsd')
    expect(field({ ...OK, caps: { maxBudgetUsd: '5' } })).toBe('caps.maxBudgetUsd')
  })

  test('effort and permissionMode are enums, not free strings', () => {
    expect(field({ ...OK, caps: { effort: 'maximum' } })).toBe('caps.effort')
    expect(field({ ...OK, caps: { permissionMode: 'yolo' } })).toBe('caps.permissionMode')
  })

  test('a legal cap set survives', () => {
    const order: Order = validateOrder({
      ...OK,
      caps: { model: 'claude-haiku-4-5-20251001', effort: 'low', maxBudgetUsd: 3, permissionMode: 'dontAsk' },
    })
    expect(order.caps).toEqual({
      model: 'claude-haiku-4-5-20251001',
      effort: 'low',
      maxBudgetUsd: 3,
      permissionMode: 'dontAsk',
    })
  })
})

describe('non-objects', () => {
  test.each([null, undefined, 'order@1', 42])('%j is not an order', input => {
    expect(() => validateOrder(input)).toThrow(OrderValidationError)
  })

  test('an ARRAY of orders is not an order -- a catalogue is not its first entry', () => {
    expect(() => validateOrder([OK])).toThrow(OrderValidationError)
  })
})
