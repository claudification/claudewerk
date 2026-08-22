import { describe, expect, test } from 'bun:test'
import { CARD_TEST_CMD_KEY, checkCardTestCmd, hasBareBunTest, wrapBareBunTest } from './card-test-cmd'

/**
 * The shapes below are not invented: every one of them was read off a real card
 * on this board on 2026-08-22, when fifty of them carried a denied `test_cmd`.
 * The awkward ones -- the bare runner AFTER a `&&`, a value the writer quoted,
 * a command that carries the runner twice -- are exactly the ones a first-guess
 * regex gets wrong, so they are pinned here rather than trusted.
 */

describe('hasBareBunTest', () => {
  test('finds the bare runner at the start of a command', () => {
    expect(hasBareBunTest('bun test')).toBe(true)
    expect(hasBareBunTest('bun test src/shared/')).toBe(true)
    expect(hasBareBunTest('bun test src/broker && bun run typecheck')).toBe(true)
  })

  test('finds it AFTER a separator, which is where half the board hides it', () => {
    expect(hasBareBunTest('bun run typecheck && bun test src/shared/atomic-write.test.ts')).toBe(true)
    expect(hasBareBunTest('bun run gen-version && bun test src/x.test.ts && bun run typecheck')).toBe(true)
    expect(hasBareBunTest('(bun test src/x)')).toBe(true)
    expect(hasBareBunTest('bun run typecheck; bun test src/x')).toBe(true)
  })

  test('the wrapper form is not the bare runner -- `run` sits where `test` would have to be', () => {
    expect(hasBareBunTest('bun run test')).toBe(false)
    expect(hasBareBunTest('bun run test src/shared && bun run typecheck')).toBe(false)
    expect(hasBareBunTest('bun run typecheck && bun run lint:fast')).toBe(false)
  })

  test('nothing that merely CONTAINS the words counts', () => {
    expect(hasBareBunTest('bunx vitest run src/components')).toBe(false)
    expect(hasBareBunTest('bun run test-something')).toBe(false)
    expect(hasBareBunTest('echo "bun testing"')).toBe(false)
    expect(hasBareBunTest('')).toBe(false)
  })

  test('accepts everything the HOOK accepts -- the escape hatch and --watch', () => {
    expect(hasBareBunTest('RCLAUDE_ALLOW_RAW_BUN_TEST=1 bun test src/x')).toBe(false)
    expect(hasBareBunTest('bun test --watch src/x')).toBe(false)
  })

  test('is not left stateful by a previous call (the /g lastIndex trap)', () => {
    const cmd = 'bun test src/a && bun test src/b'
    expect(hasBareBunTest(cmd)).toBe(true)
    expect(hasBareBunTest(cmd)).toBe(true)
    expect(hasBareBunTest(cmd)).toBe(true)
  })
})

describe('wrapBareBunTest', () => {
  test('routes the runner through the wrapper, leaving everything else alone', () => {
    expect(wrapBareBunTest('bun test')).toBe('bun run test')
    expect(wrapBareBunTest('bun test src/shared/ && bun run typecheck')).toBe(
      'bun run test src/shared/ && bun run typecheck',
    )
  })

  test('rewrites it where it sits, not only at the start', () => {
    expect(wrapBareBunTest('bun run typecheck && bun test src/x.test.ts')).toBe(
      'bun run typecheck && bun run test src/x.test.ts',
    )
  })

  test('rewrites EVERY occurrence -- half a fix is a command that still cannot run', () => {
    expect(wrapBareBunTest('bun test src/a && bun test src/b')).toBe('bun run test src/a && bun run test src/b')
  })

  test('leaves an already-wrapped command byte-identical (idempotent)', () => {
    const wrapped = 'bun run test src/shared && bun run typecheck'
    expect(wrapBareBunTest(wrapped)).toBe(wrapped)
    expect(wrapBareBunTest(wrapBareBunTest('bun test src/shared && bun run typecheck'))).toBe(wrapped)
  })

  test('keeps flags and quoted arguments after the runner', () => {
    expect(wrapBareBunTest('bun test src/sentinel/git-fabric.test.ts -t "scans the current repo"')).toBe(
      'bun run test src/sentinel/git-fabric.test.ts -t "scans the current repo"',
    )
  })

  test('does not touch a command the hook would have let through', () => {
    expect(wrapBareBunTest('RCLAUDE_ALLOW_RAW_BUN_TEST=1 bun test src/x')).toBe(
      'RCLAUDE_ALLOW_RAW_BUN_TEST=1 bun test src/x',
    )
    expect(wrapBareBunTest('bun test --watch src/x')).toBe('bun test --watch src/x')
  })
})

describe('checkCardTestCmd', () => {
  test('says nothing about a card with no test_cmd, or one that uses the wrapper', () => {
    expect(checkCardTestCmd({ id: 'c', meta: {} })).toEqual([])
    expect(checkCardTestCmd({ id: 'c', meta: { [CARD_TEST_CMD_KEY]: '' } })).toEqual([])
    expect(checkCardTestCmd({ id: 'c', meta: { [CARD_TEST_CMD_KEY]: 'bun run test src/shared' } })).toEqual([])
  })

  test('reports the bare runner as an ERROR and names the wrapper form in the remedy', () => {
    const [finding] = checkCardTestCmd({
      id: 'some-card',
      meta: { [CARD_TEST_CMD_KEY]: 'bun test src/shared && bun run typecheck' },
    })
    expect(finding.check).toBe('card-test-cmd-denied')
    expect(finding.severity).toBe('error')
    expect(finding.subject).toBe('some-card')
    expect(finding.problem).toContain('guard-raw-bun-test.sh')
    expect(finding.remedy).toContain('bun run test src/shared && bun run typecheck')
  })

  test('sees through the quotes a writer left on the value', () => {
    const [finding] = checkCardTestCmd({
      id: 'c',
      meta: { [CARD_TEST_CMD_KEY]: '"bun test src/broker/epic-sweep.test.ts"' },
    })
    expect(finding).toBeDefined()
    expect(finding.remedy).toContain('bun run test src/broker/epic-sweep.test.ts')
  })

  test('passes over a shape it cannot read -- `card-key-type` already reports that', () => {
    expect(checkCardTestCmd({ id: 'c', meta: { [CARD_TEST_CMD_KEY]: ['bun test src/x'] } })).toEqual([])
  })
})
