import { describe, expect, it } from 'bun:test'
import type { CmdRunner } from './board-gate-checks'
import {
  DEFAULT_SUITE_RULES,
  deriveSuites,
  parseChangedPaths,
  runDerivedSuites,
  type SuiteRule,
  suiteCommand,
} from './board-gate-suites'

const ids = (rules: SuiteRule[]) => rules.map(r => r.id)

describe('deriveSuites — what the diff owes', () => {
  it('a web-only diff owes the web suite AND the root suite', () => {
    // Root tests read web/src off disk, so a web-only change can redden them.
    expect(ids(deriveSuites(['web/src/components/wall/werk-master-detail.test.tsx']))).toEqual(['root', 'web'])
  })

  it('a src/broker-only diff owes only the root suite', () => {
    expect(ids(deriveSuites(['src/broker/epic-ready.ts']))).toEqual(['root'])
  })

  it('THE GEN-10 REGRESSION: a diff confined to src/shared owes the web suite', () => {
    // b9b12b4c touched only src/shared/epic-run-caps.ts and reddened
    // web/src/components/wall/runs/run-model.test.ts, which imports @shared.
    // A rule keyed on `web/` file paths alone says green here -- this is the case
    // that must not.
    expect(ids(deriveSuites(['src/shared/epic-run-caps.ts']))).toEqual(['root', 'web'])
  })

  it('a diff that touches neither tree owes nothing', () => {
    expect(deriveSuites(['docs/bridge-protocol.md', '.rclaude/project/cards/x.md'])).toEqual([])
  })

  it('an empty diff owes nothing', () => {
    expect(deriveSuites([])).toEqual([])
  })

  it('only rules the host actually supplied can fire', () => {
    // The host filters the table against package.json, so a project with no
    // `test:web` script never gets refused for a suite it does not have.
    const rootOnly = DEFAULT_SUITE_RULES.filter(r => r.id === 'root')
    expect(ids(deriveSuites(['web/src/app.tsx'], rootOnly))).toEqual(['root'])
    expect(deriveSuites(['src/shared/x.ts'], [])).toEqual([])
  })
})

describe('parseChangedPaths', () => {
  it('splits, trims and drops blanks', () => {
    expect(parseChangedPaths('src/a.ts\n\n  web/b.tsx  \n')).toEqual(['src/a.ts', 'web/b.tsx'])
  })
  it('normalizes a leading ./ so prefix matching still works', () => {
    expect(deriveSuites(parseChangedPaths('./web/src/a.tsx'))).toHaveLength(2)
  })
})

describe('runDerivedSuites', () => {
  const pass: CmdRunner = async () => ({ exitCode: 0, output: 'ok', timedOut: false })
  const failWeb: CmdRunner = async cmd =>
    cmd === 'bun run test:web'
      ? { exitCode: 1, output: 'run-model.test.ts: expected 2 rows', timedOut: false }
      : { exitCode: 0, output: 'ok', timedOut: false }
  const timeout: CmdRunner = async () => ({ exitCode: -1, output: 'hung', timedOut: true })

  const opts = (over: Partial<Parameters<typeof runDerivedSuites>[0]> = {}) => ({
    changed: ['src/shared/epic-run-caps.ts'],
    rules: DEFAULT_SUITE_RULES,
    testCmd: '',
    runCmd: pass,
    timeoutMs: 1000,
    ...over,
  })

  it('runs every obliged suite and names each command in the entries', async () => {
    const out = await runDerivedSuites(opts())
    expect(out.checks.map(c => c.name)).toEqual(['suite:root', 'suite:web'])
    expect(out.checks.every(c => c.ok)).toBe(true)
    expect(out.entries).toEqual(['root: bun run test -> pass', 'web: bun run test:web -> pass'])
  })

  it('a narrow test_cmd cannot hide a broken web file -- the derived web suite fails', async () => {
    const out = await runDerivedSuites(opts({ testCmd: 'bun run test src/broker', runCmd: failWeb }))
    const web = out.checks.find(c => c.name === 'suite:web')
    expect(web?.ok).toBe(false)
    expect(web?.detail).toContain('bun run test:web exit 1')
    expect(web?.detail).toContain('run-model.test.ts')
    expect(out.entries).toContain('web: bun run test:web -> fail')
  })

  it('does not run a suite twice when test_cmd IS that command', async () => {
    const seen: string[] = []
    const spy: CmdRunner = async cmd => {
      seen.push(cmd)
      return { exitCode: 0, output: '', timedOut: false }
    }
    const out = await runDerivedSuites(opts({ testCmd: 'bun run test', runCmd: spy }))
    expect(seen).toEqual(['bun run test:web'])
    expect(out.entries).toContain('root: bun run test -> pass')
  })

  it('a timed-out suite is a failure, and says timeout rather than fail', async () => {
    const out = await runDerivedSuites(opts({ runCmd: timeout }))
    expect(out.checks.every(c => c.ok)).toBe(false)
    expect(out.entries[0]).toContain('-> timeout')
  })

  it('nothing obliged -> no checks, and the entry says so instead of implying a suite ran', async () => {
    const out = await runDerivedSuites(opts({ changed: ['docs/x.md'] }))
    expect(out.checks).toEqual([])
    expect(out.entries[0]).toContain('none')
  })
})

describe('suiteCommand', () => {
  it('is a root-relative bun script, runnable from the gated checkout', () => {
    expect(DEFAULT_SUITE_RULES.map(suiteCommand)).toEqual(['bun run test', 'bun run test:web'])
  })
})
