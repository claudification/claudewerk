#!/usr/bin/env bun

/**
 * Biome in CHECK mode -- the biome half of `lint:fast`, and the reason it can
 * now fail instead of silently rewriting your tree.
 *
 * `bunx biome check --fix .` REWRITES FILES AND EXITS 0. Nothing on the commit
 * path can tell "the tree was already formatted" from "the tree was reformatted
 * just now", so unformatted code lands on `main` routinely and every worktree
 * cut from `main` afterwards opens with stray modified files belonging to
 * nobody. Twice in one month, same cause, fixed twice as one-off format commits
 * (`main-biome-residue-conversation-item-helpers`,
 * `main-biome-residue-worktree-shell-tests`).
 *
 * So the gate never writes. It runs `biome check` WITHOUT `--fix` and fails
 * loud when a fix WOULD have been applied. `bun run lint:biome:fix` is the
 * writer, and running it is the author's call -- which keeps a commit's diff
 * equal to what its author wrote.
 *
 * ERROR SEVERITY ONLY, DELIBERATELY. A clean `main` carries ~142 biome WARNINGS
 * and 4 infos: unsafe fixes biome refuses to apply unprompted (e.g.
 * `Promise<void[]>` -> `Promise<undefined[]>`). Gating on those would land this
 * permanently red, which is how a gate gets disabled. Cleaning them up is a
 * separate, judgement-heavy job. Filtering on severity here rather than leaning
 * on biome's own exit code makes that boundary explicit instead of incidental.
 *
 * Run: `bun run scripts/lint-biome-check.ts`
 * Exits 0 = no error-severity diagnostics, 1 = at least one.
 */

import { join } from 'node:path'
import { type LintFinding, reportAndExit } from './lib/lint-report'

const ROOT = join(import.meta.dir, '..')

/**
 * Well past the ~150 diagnostics a clean tree emits, because biome's default of
 * 20 would hide errors behind warnings. Whatever it still drops is REPORTED --
 * see `unprintedErrors` -- rather than passing as "nothing found".
 */
const MAX_DIAGNOSTICS = 1000

export interface BiomeDiagnostic {
  severity?: string
  category?: string
  message?: string
  location?: { path?: string; start?: { line?: number } | null } | null
}

export interface BiomeReport {
  summary?: { errors?: number }
  diagnostics?: BiomeDiagnostic[]
}

/** `--reporter=json` output, or null when biome printed something that is not a report. */
export function parseReport(raw: string): BiomeReport | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as BiomeReport) : null
  } catch {
    return null
  }
}

/**
 * One line under the location. A `format` diagnostic's own message is the head
 * of a whole-file diff ("Formatter would have printed the following content:"),
 * which reads as a truncated sentence on its own -- say what it means instead.
 */
function detailOf(diagnostic: BiomeDiagnostic): string {
  if (diagnostic.category === 'format') return 'not formatted -- biome would rewrite this file'
  return `${diagnostic.category ?? 'biome'} -- ${diagnostic.message ?? '(no message)'}`
}

/**
 * The error-severity diagnostics, as findings. Warnings and infos are dropped
 * on purpose; see the ERROR SEVERITY ONLY note at the top.
 *
 * A `format` diagnostic covers a whole file and carries line 0, which is what
 * the report prints -- an honest "no particular line" rather than a fabricated
 * `:1`.
 */
export function errorFindings(report: BiomeReport): LintFinding[] {
  return (report.diagnostics ?? [])
    .filter(diagnostic => diagnostic.severity === 'error')
    .map(diagnostic => ({
      file: diagnostic.location?.path ?? '(unknown file)',
      line: diagnostic.location?.start?.line ?? 0,
      detail: detailOf(diagnostic),
    }))
}

/**
 * Errors biome COUNTED but did not PRINT, given how many we parsed. Non-zero
 * means `MAX_DIAGNOSTICS` truncated the report; a gate that swallowed that
 * would under-report and read as cleaner than the tree is.
 */
export function unprintedErrors(report: BiomeReport, shown: number): number {
  return Math.max(0, (report.summary?.errors ?? 0) - shown)
}

const HINT =
  'Fix: `bun run lint:biome:fix` -- that command WRITES, this gate never does.\n' +
  'Then read the diff and commit it deliberately. A rewrite belongs in a commit\n' +
  'its author chose, not in one it rode along in.\n' +
  'Only error severity fails here; biome warnings are out of scope by design.'

function runGate(): never {
  const proc = Bun.spawnSync(
    ['bunx', 'biome', 'check', '.', '--reporter=json', `--max-diagnostics=${MAX_DIAGNOSTICS}`],
    { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' },
  )
  const stdout = proc.stdout.toString()
  const stderr = proc.stderr.toString()

  const report = parseReport(stdout)
  if (!report) {
    console.error('\nbiome: no JSON report on stdout -- biome itself failed to run.\n')
    console.error(stderr || stdout)
    process.exit(1)
  }

  const findings = errorFindings(report)
  const hidden = unprintedErrors(report, findings.length)
  if (hidden > 0) {
    findings.push({
      file: '(report truncated)',
      line: 0,
      detail: `${hidden} further error(s) biome counted but did not print -- raise MAX_DIAGNOSTICS in scripts/lint-biome-check.ts`,
    })
  }

  // Biome can fail for reasons that produce no error-severity diagnostic at all
  // (bad config, unreadable file). Reporting OK on that would be the exact
  // silent pass this gate exists to remove.
  if (findings.length === 0 && proc.exitCode !== 0) {
    console.error(
      `\nbiome: exited ${proc.exitCode} with no error-severity diagnostic -- failing rather than guessing.\n`,
    )
    console.error(stderr || stdout)
    process.exit(proc.exitCode || 1)
  }

  reportAndExit(
    findings,
    'biome: check mode, no error-severity diagnostics, tree untouched -- OK',
    n => `biome: ${n} error-severity diagnostic(s) -- the tree was NOT modified`,
    HINT,
  )
}

if (import.meta.main) runGate()
