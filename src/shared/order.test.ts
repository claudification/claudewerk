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
  isCommandLineSafe,
  ORDER_FLAG_ALLOWLIST,
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
  seat: 'verifier',
  prompt: 'guard',
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
    expect(order.seat).toBe('verifier')
  })

  test('the version is part of the discriminator -- order@2 is not an order@1', () => {
    expect(field({ ...OK, kind: 'order@2' })).toBe('kind')
    expect(field({ ...OK, kind: 'hire@1' })).toBe('kind')
  })

  test('an id must carry its version', () => {
    expect(field({ ...OK, id: 'REVIEWER' })).toBe('id')
    expect(field({ ...OK, id: 'reviewer@1' })).toBe('id')
  })

  test('an unknown seat or prompt is refused, not coerced', () => {
    expect(field({ ...OK, seat: 'root' })).toBe('seat')
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

describe('the default-deny flag allowlist', () => {
  test('the four allowed flags pass', () => {
    const order = validateOrder({
      ...OK,
      flags: { '--model': 'claude-opus-5', '--effort': 'high', '--agent': 'code-reviewer', '--max-budget-usd': '5' },
    })
    expect(Object.keys(order.flags ?? {}).sort()).toEqual([...ORDER_FLAG_ALLOWLIST].sort())
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
