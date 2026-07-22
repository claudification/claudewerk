#!/usr/bin/env bun

/**
 * Test-runner lint: keeps each test file importing the runner that will
 * actually execute it.
 *
 *   src/**  -> bun:test   (bunfig.toml scopes `bun test` to root = "src")
 *   web/**  -> vitest     (the Vite/jsdom ecosystem its tests need)
 *
 * Why this exists: getting it wrong fails SILENTLY in the worst direction.
 * A `bun:test` import under `web/` makes vitest fail the whole file at LOAD
 * time (it reports as a failed suite with "no tests", easy to skim past),
 * while `bun test` never picks the file up at all -- so the tests simply stop
 * running and nothing says so. `web/public/pcm-worklet.test.ts` sat dead this
 * way (8 passing DSP tests, executed by neither runner) until 2026-07.
 *
 * Run: `bun run scripts/lint-test-runner.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { scanSourceFiles } from './lib/source-files'

const ROOT = join(import.meta.dir, '..')

interface Rule {
  dir: string
  runner: string
  banned: string
}

const RULES: Rule[] = [
  { dir: 'src', runner: 'bun:test', banned: 'vitest' },
  { dir: 'web', runner: 'vitest', banned: 'bun:test' },
]

interface Violation {
  file: string
  line: number
  banned: string
  runner: string
}

/** `import ... from '<module>'` for the banned runner, anywhere in the file. */
function bannedImportLine(source: string, banned: string): number {
  const pattern = new RegExp(`from\\s*['"]${banned}['"]`)
  const lines = source.split('\n')
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) return i + 1
  }
  return 0
}

function scanRule(rule: Rule): Violation[] {
  const abs = join(ROOT, rule.dir)
  const found: Violation[] = []
  for (const rel of scanSourceFiles(abs, '**/*.{test,spec}.{ts,tsx}')) {
    const line = bannedImportLine(readFileSync(join(abs, rel), 'utf8'), rule.banned)
    if (line > 0) found.push({ file: join(rule.dir, rel), line, banned: rule.banned, runner: rule.runner })
  }
  return found
}

const violations = RULES.flatMap(scanRule)

if (violations.length === 0) {
  console.log('test-runner: every test file imports its own runner -- OK')
  process.exit(0)
}

console.error(`\ntest-runner: ${violations.length} test file(s) importing the WRONG runner\n`)
for (const v of violations) {
  console.error(`  ${v.file}:${v.line}`)
  console.error(`    imports '${v.banned}' but this path runs under '${v.runner}' -- the tests will not execute`)
  console.error()
}
console.error("Fix: import from the runner that owns the path (src/ -> 'bun:test', web/ -> 'vitest').\n")

process.exit(1)
