/**
 * WHICH SUITES A DIFF OWES -- derived from what it touched, never from what the
 * card remembered to type.
 *
 * `test_cmd` is hand-written per card by whoever filed it, with no relationship
 * to the files the card ends up changing. Three times on this board a card edited
 * `web/` (or a `src/shared` module `web/` imports) while its `test_cmd` ran only
 * the root suite; twice a werk-master caught it by hand after the merge, and the
 * third landed RED on main and stayed red for a full generation. A `test_cmd`
 * that cannot fail reads exactly like a card that was actually tested.
 *
 * So the gate DERIVES the suites from `git diff --name-only base...HEAD` and runs
 * them IN ADDITION to `test_cmd`, which stays as the card's way to ask for
 * something narrower or extra -- never as the only thing that runs.
 *
 * Pure: the runner is injected, the rules are injected (the host filters them
 * against the checkout's package.json), so the truth table is unit-testable with
 * no repo and no suite.
 */

import type { CmdRunner, GateCheck } from './board-gate-checks'

export interface SuiteRule {
  /** Short stable id -- what the card's evidence calls this suite. */
  id: string
  /** package.json script; the gate runs `bun run <script>` at the checkout root. */
  script: string
  /** Repo-relative path prefixes that oblige this suite. */
  triggers: readonly string[]
  /** Why these prefixes and not others. Read this before editing the list. */
  why: string
}

/**
 * This repo's table. Both rules are deliberately WIDER than "the file lives in
 * that tree", because the two regressions that got through were both cross-tree:
 *
 * - `src/shared/` obliges the WEB suite: 478 files under `web/src` import
 *   `@shared/*`. The gen-10 break was exactly this shape -- a diff confined to
 *   `src/shared/epic-run-caps.ts` reddened `web/src/.../run-model.test.ts` with
 *   no `web/` file in the diff at all. A rule keyed on `web/` paths alone would
 *   have said green.
 * - `web/` obliges the ROOT suite: root tests read `web/src` off disk
 *   (transport-meta-boundary, module-mock-completeness) and several lint scripts
 *   scan it, so a web-only diff can redden a suite it never imports.
 *
 * The cost of both firing on most cards is a few minutes of gate. The cost of
 * neither firing is a red main nobody can see.
 */
export const DEFAULT_SUITE_RULES: readonly SuiteRule[] = [
  {
    id: 'root',
    script: 'test',
    triggers: ['src/', 'scripts/', 'packages/', 'workers/', 'web/'],
    why: 'root tests + lint scripts read web/src off disk, so a web-only diff can break them',
  },
  {
    id: 'web',
    script: 'test:web',
    triggers: ['web/', 'src/shared/'],
    why: 'web/src imports @shared/* in 478 files -- a src/shared-only diff breaks web importers',
  },
]

export function suiteCommand(rule: SuiteRule): string {
  return `bun run ${rule.script}`
}

/** `git diff --name-only` output -> normalized repo-relative paths. */
export function parseChangedPaths(stdout: string): string[] {
  return stdout
    .split('\n')
    .map(s => s.trim())
    .filter(Boolean)
    .map(p => (p.startsWith('./') ? p.slice(2) : p))
}

/** The rules a diff obliges, in table order. Empty diff -> empty. */
export function deriveSuites(
  changed: readonly string[],
  rules: readonly SuiteRule[] = DEFAULT_SUITE_RULES,
): SuiteRule[] {
  return rules.filter(rule => changed.some(path => rule.triggers.some(t => path.startsWith(t))))
}

/** One line of the card's `evidence_suites` -- the command, named, with its result. */
export function suiteEntry(id: string, cmd: string, result: 'pass' | 'fail' | 'timeout' | 'skipped'): string {
  return `${id}: ${cmd} -> ${result}`
}

export interface SuiteRunOptions {
  changed: readonly string[]
  rules: readonly SuiteRule[]
  /** The card's own `test_cmd`, so an identical derived command is not run twice. */
  testCmd: string
  runCmd: CmdRunner
  timeoutMs: number
}

export interface SuiteRunOutcome {
  checks: GateCheck[]
  /** What actually ran, for `evidence_suites`. Never a promise that it did. */
  entries: string[]
}

function tail(text: string, maxChars: number): string {
  const t = text.trimEnd()
  return t.length <= maxChars ? t : `…${t.slice(t.length - maxChars)}`
}

/**
 * Run every suite the diff obliges. A suite whose command IS the card's
 * `test_cmd` is not run a second time -- `test_cmd` already ran it, and the
 * entry says so rather than pretending two things happened.
 */
export async function runDerivedSuites(o: SuiteRunOptions): Promise<SuiteRunOutcome> {
  const derived = deriveSuites(o.changed, o.rules)
  if (derived.length === 0) {
    return { checks: [], entries: [`derived: (none -- ${o.changed.length} changed path(s) match no suite trigger)`] }
  }

  const checks: GateCheck[] = []
  const entries: string[] = []
  for (const rule of derived) {
    const cmd = suiteCommand(rule)
    if (cmd === o.testCmd) {
      entries.push(suiteEntry(rule.id, cmd, 'pass'))
      continue
    }
    const r = await o.runCmd(cmd, o.timeoutMs)
    const passed = r.exitCode === 0 && !r.timedOut
    entries.push(suiteEntry(rule.id, cmd, passed ? 'pass' : r.timedOut ? 'timeout' : 'fail'))
    checks.push({
      name: `suite:${rule.id}`,
      ok: passed,
      detail: passed
        ? `${cmd} exit 0 (obliged by the diff: ${rule.why})`
        : r.timedOut
          ? `${cmd} timed out after ${o.timeoutMs}ms -- the diff obliges this suite (${rule.why})`
          : `${cmd} exit ${r.exitCode} -- the diff obliges this suite (${rule.why}): ${tail(r.output, 300)}`,
    })
  }
  return { checks, entries }
}
