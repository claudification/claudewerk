#!/usr/bin/env bun

/**
 * Version-control configuration does not get unit tests.
 *
 * `.gitignore`, `.gitattributes` and friends are configuration for a tool that
 * already has its own test suite. A test that shells out to `git check-ignore`
 * -- or copies our `.gitignore` into a scratch repo and asks `git status` what
 * it would stage -- is asserting that git honours git. Our code is not in the
 * call path. It can only ever fail for two reasons: git changed (it did not),
 * or somebody edited the config on purpose (in which case the test is a
 * speed bump, not a safety net).
 *
 * WHY THIS EXISTS (2026-08-21): a fleet run decided the project board belonged
 * in git, then defended that decision with 332 lines of test across two files
 * -- `board-gitignore.test.ts` and a sparse-checkout suite. The premise was
 * reverted 48 minutes later (`7ee496a4`); the tests had made a fifteen-minute
 * decision expensive to walk back. One of them survived the revert and sat RED
 * on main for hours, asserting a policy the generator had already stopped
 * emitting.
 *
 * The rule is deliberately narrow, and it is about the ASSERTION, not the word.
 * Testing code that WRITES a config file is fine -- assert the bytes you
 * generate. What is banned is handing those bytes to git and testing git's
 * reply, or reading a checked-in config file back to check its contents.
 *
 * Run: `bun run scripts/lint-no-config-tests.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { type LintFinding, reportAndExit } from './lib/lint-report'
import { scanSourceFiles } from './lib/source-files'

const ROOT = join(import.meta.dir, '..')

/** Directories whose `*.test.ts` files are subject to the rule. */
const TEST_ROOTS = ['src', 'web', 'scripts', 'packages']

interface Ban {
  /** Matched against code (comments stripped) -- a literal, not a word. */
  token: string
  why: string
}

const BANS: Ban[] = [
  { token: 'check-ignore', why: 'asks git whether git ignores a path -- that is a test of git' },
  { token: '.gitignore', why: 'reads or asserts a .gitignore; VCS config is not unit-testable behaviour' },
  { token: '.gitattributes', why: 'reads or asserts a .gitattributes; same rule as .gitignore' },
  { token: 'sparse-checkout', why: 'asserts a git working-tree layout, not our code' },
]

/**
 * `source` with line and block comments blanked out, so a doc comment that
 * merely MENTIONS `.gitignore` is not a violation. Only code counts.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
}

/** First code line in `code` containing `token`, or 0 if absent. */
function offendingLine(code: string, token: string): number {
  const lines = code.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(token)) return i + 1
  }
  return 0
}

function scanRoot(dir: string): LintFinding[] {
  const abs = join(ROOT, dir)
  const found: LintFinding[] = []
  for (const rel of scanSourceFiles(abs, '**/*.{test,spec}.{ts,tsx}')) {
    const code = stripComments(readFileSync(join(abs, rel), 'utf8'))
    for (const ban of BANS) {
      const line = offendingLine(code, ban.token)
      if (line > 0) found.push({ file: join(dir, rel), line, detail: `'${ban.token}' -- ${ban.why}` })
    }
  }
  return found
}

reportAndExit(
  TEST_ROOTS.flatMap(scanRoot),
  'no-config-tests: no test asserts VCS configuration -- OK',
  n => `no-config-tests: ${n} test(s) asserting version-control configuration`,
  'Git configuration for this repo does not get tests. Delete the assertion.\n' +
    'Testing a generator? Assert the BYTES it writes -- never hand them to git and test the reply.',
)
