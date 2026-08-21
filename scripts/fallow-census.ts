#!/usr/bin/env bun

/**
 * Whole-repo complexity census.
 *
 * `bun run lint:fallow` gates on the CHANGED FILE SET. This answers the other
 * question -- what is the repo actually sitting on, and how much of it is the
 * gate structurally unable to see. See docs/fallow-audit-scope.md.
 *
 *   bun run fallow:census                 # census + how much is invisible
 *   bun run fallow:census --top 40
 *   bun run fallow:census --json
 *   bun run fallow:census --file src/shared/board-sweep.ts
 *   bun run fallow:census --save .fallow/census.json
 *   bun run fallow:census --check .fallow/census.json
 *
 * Exit 0 always, EXCEPT `--check`, which exits 1 when a function appeared above
 * threshold or got worse. This is a census, not a gate: it reports, it does not
 * block a commit. Nothing wires it into `bun run lint`.
 */

import { spawnSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildCensus, type Census, finiteNumber, parseGateScope, parseHealthFindings } from './lib/fallow-census'
import { deltaIsClean, diffSnapshots, parseSnapshot, serializeSnapshot, toSnapshot } from './lib/fallow-census-diff'
import { formatCensus, formatDelta, formatFileVerdict } from './lib/fallow-census-format'

const ROOT = join(import.meta.dir, '..')
const FALLOW = join(ROOT, 'node_modules/.bin/fallow')

interface Options {
  top: number
  json: boolean
  file?: string
  save?: string
  check?: string
}

function fail(message: string): never {
  console.error(`fallow-census: ${message}`)
  process.exit(2)
}

interface Flag {
  /** How many following argv entries this flag consumes. */
  arity: 0 | 1
  apply: (options: Options, value: string) => void
}

const FLAGS: Record<string, Flag> = {
  '--json': {
    arity: 0,
    apply(options) {
      options.json = true
    },
  },
  '--top': {
    arity: 1,
    apply(options, value) {
      options.top = Number(value)
    },
  },
  '--file': {
    arity: 1,
    apply(options, value) {
      options.file = value
    },
  },
  '--save': {
    arity: 1,
    apply(options, value) {
      options.save = value
    },
  },
  '--check': {
    arity: 1,
    apply(options, value) {
      options.check = value
    },
  },
}

function assertTop(top: number): void {
  if (!Number.isFinite(top) || top <= 0) fail('--top needs a positive number')
}

function parseArgs(argv: string[]): Options {
  const options: Options = { top: 25, json: false }
  for (let i = 0; i < argv.length; i++) {
    const flag = FLAGS[argv[i]]
    if (!flag) fail(`unknown argument '${argv[i]}' (see the header of scripts/fallow-census.ts)`)
    flag.apply(options, argv[i + flag.arity])
    i += flag.arity
  }
  assertTop(options.top)
  return options
}

function parseJsonOrFail(result: { stdout: string; stderr: string; status: number | null }, args: string[]): unknown {
  try {
    return JSON.parse(result.stdout)
  } catch {
    console.error(String(result.stderr).slice(0, 2000))
    return fail(`\`fallow ${args.join(' ')}\` produced no JSON (exit ${result.status})`)
  }
}

/**
 * fallow exits 1 when it finds issues, which is the normal case here. Only a
 * missing or garbled stdout is a real failure.
 */
function runFallow(args: string[]): unknown {
  const result = spawnSync(FALLOW, [...args, '--format', 'json', '--quiet'], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
  })
  if (result.error) fail(`cannot run ${FALLOW}: ${result.error.message}`)
  return parseJsonOrFail(result, args)
}

function repoTotals(health: unknown): { filesAnalyzed: number; functionsAnalyzed: number } {
  const summary = (health as { summary?: Record<string, unknown> }).summary ?? {}
  return {
    filesAnalyzed: finiteNumber(summary.files_analyzed),
    functionsAnalyzed: finiteNumber(summary.functions_analyzed),
  }
}

function collectCensus(): Census {
  const health = runFallow(['health'])
  const brief = runFallow(['audit', '--brief'])
  return buildCensus(parseHealthFindings(health), parseGateScope(brief), repoTotals(health))
}

function checkDrift(census: Census, path: string): never {
  const previous = parseSnapshot(JSON.parse(readFileSync(path, 'utf8')))
  const delta = diffSnapshots(previous, toSnapshot(census, new Date().toISOString()))
  console.log(formatDelta(delta, previous.savedAt))
  process.exit(deltaIsClean(delta) ? 0 : 1)
}

function saveSnapshot(census: Census, path: string): void {
  const snapshot = toSnapshot(census, new Date().toISOString())
  writeFileSync(path, serializeSnapshot(snapshot))
  console.error(`fallow-census: wrote ${snapshot.rows.length} rows to ${path}`)
}

function report(census: Census, options: Options): void {
  console.log(options.json ? JSON.stringify(census, null, 2) : formatCensus(census, options.top))
}

function main(): void {
  const options = parseArgs(process.argv.slice(2))
  const census = collectCensus()
  if (options.file) {
    console.log(formatFileVerdict(census, options.file))
    return
  }
  if (options.check) checkDrift(census, options.check)
  if (options.save) saveSnapshot(census, options.save)
  report(census, options)
}

main()
