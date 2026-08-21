/**
 * The biome gate: `lint:fast` must CHECK, never WRITE.
 *
 * Regression case for `lint-fast-rewrites-tree-exit-zero`. The failure this
 * guards is not subtle and has already happened twice: `lint:fast` began with
 * `bunx biome check --fix .`, which rewrites files and exits 0, so unformatted
 * code kept landing on `main` and every worktree cut from it afterwards opened
 * with stray modified files belonging to nobody.
 *
 * Two halves, and both matter:
 *
 * - The WIRING half asserts the bytes of our own `package.json` scripts -- no
 *   write flag is reachable from `lint:fast`. That is the exact edit that would
 *   reintroduce the bug, and it is a one-word edit.
 * - The REPORTING half covers `scripts/lint-biome-check.ts`'s pure functions,
 *   which decide what counts as a failure. Severity filtering is the reason a
 *   clean `main`'s ~142 biome warnings do not land the gate permanently red.
 *
 * Deliberately NOT here: running biome and asserting its reply. Biome ships its
 * own test suite and none of our code is in that call path.
 */

import { describe, expect, test } from 'bun:test'
import { join } from 'node:path'
import { type BiomeReport, errorFindings, parseReport, unprintedErrors } from '../../scripts/lint-biome-check'

const PACKAGE_JSON = join(import.meta.dir, '../../package.json')

/** Flags that make a lint command modify the working tree. `--fix` also covers `--fix-unsafe`. */
const WRITE_FLAGS = ['--fix', '--write', '--apply']

async function scripts(): Promise<Record<string, string>> {
  return (await Bun.file(PACKAGE_JSON).json()).scripts
}

/** Every command `lint:fast` actually executes: itself, plus each `bun run <x>` it chains. */
function expandChain(all: Record<string, string>, entry: string): string[] {
  const self = all[entry]
  const nested = [...self.matchAll(/bun run ([\w:-]+)/g)]
    .map(m => all[m[1]])
    .filter((cmd): cmd is string => cmd !== undefined)
  return [self, ...nested]
}

describe('lint:fast is a gate, not a formatter', () => {
  test('no write flag is reachable from lint:fast', async () => {
    const all = await scripts()
    for (const command of expandChain(all, 'lint:fast')) {
      for (const flag of WRITE_FLAGS) {
        expect(command, `lint:fast reaches a command that WRITES: ${command}`).not.toContain(flag)
      }
    }
  })

  test('lint:fast runs the check-mode biome gate', async () => {
    const all = await scripts()
    expect(all['lint:fast']).toContain('bun run lint:biome')
    expect(all['lint:biome']).toBe('bun run scripts/lint-biome-check.ts')
  })

  test('the writer still exists, under a name that says so', async () => {
    const all = await scripts()
    expect(all['lint:biome:fix']).toContain('--fix')
  })
})

describe('errorFindings', () => {
  const report: BiomeReport = {
    summary: { errors: 2 },
    diagnostics: [
      {
        severity: 'warning',
        category: 'lint/style/useTemplate',
        message: 'prefer a template',
        location: { path: 'a.ts', start: { line: 51 } },
      },
      {
        severity: 'info',
        category: 'lint/style/useTemplate',
        message: 'prefer a template',
        location: { path: 'b.ts', start: { line: 7 } },
      },
      {
        severity: 'error',
        category: 'format',
        message: 'Formatter would have printed the following content:',
        location: { path: 'c.ts', start: { line: 0 } },
      },
      {
        severity: 'error',
        category: 'lint/correctness/noUnusedImports',
        message: 'unused import',
        location: { path: 'd.ts', start: { line: 12 } },
      },
    ],
  }

  test('keeps errors and drops warnings and infos', () => {
    expect(errorFindings(report).map(f => f.file)).toEqual(['c.ts', 'd.ts'])
  })

  test('a format error reads as a whole-file finding, not a truncated sentence', () => {
    const [format] = errorFindings(report)
    expect(format.line).toBe(0)
    expect(format.detail).toBe('not formatted -- biome would rewrite this file')
  })

  test('a lint error keeps its rule name and biome wording', () => {
    const lint = errorFindings(report)[1]
    expect(lint.line).toBe(12)
    expect(lint.detail).toBe('lint/correctness/noUnusedImports -- unused import')
  })

  test('an empty report is not a failure', () => {
    expect(errorFindings({})).toEqual([])
    expect(errorFindings({ diagnostics: [] })).toEqual([])
  })

  test('a diagnostic with no location still reports', () => {
    const findings = errorFindings({ diagnostics: [{ severity: 'error', category: 'format' }] })
    expect(findings).toEqual([
      { file: '(unknown file)', line: 0, detail: 'not formatted -- biome would rewrite this file' },
    ])
  })
})

describe('unprintedErrors', () => {
  test('reports what the diagnostic cap swallowed', () => {
    expect(unprintedErrors({ summary: { errors: 30 } }, 20)).toBe(10)
  })

  test('never goes negative when biome printed everything', () => {
    expect(unprintedErrors({ summary: { errors: 2 } }, 2)).toBe(0)
    expect(unprintedErrors({}, 0)).toBe(0)
  })
})

describe('parseReport', () => {
  test('null when biome printed something that is not a report', () => {
    expect(parseReport('error: unknown option --reporter=json')).toBeNull()
    expect(parseReport('')).toBeNull()
    expect(parseReport('null')).toBeNull()
  })

  test('parses a report', () => {
    expect(parseReport('{"summary":{"errors":1},"diagnostics":[]}')).toEqual({
      summary: { errors: 1 },
      diagnostics: [],
    })
  })
})
