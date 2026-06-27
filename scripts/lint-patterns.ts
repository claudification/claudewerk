#!/usr/bin/env bun

import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const baselineFile = join(root, '.sg', 'baseline.json')
const updateBaseline = process.argv.includes('--update-baseline')

interface SgMatch {
  file: string
  range: { start: { line: number; column: number }; end: { line: number; column: number } }
}

const dirs = ['src/', 'web/src/']

let raw: string
try {
  raw = execSync(`bunx sg scan ${dirs.join(' ')} --json 2>/dev/null`, {
    cwd: root,
    maxBuffer: 10 * 1024 * 1024,
  }).toString()
} catch (e: any) {
  raw = e.stdout?.toString() ?? '[]'
}

const matches: SgMatch[] = JSON.parse(raw || '[]')

function contains(outer: SgMatch, inner: SgMatch): boolean {
  return (
    outer.file === inner.file &&
    outer.range.start.line <= inner.range.start.line &&
    outer.range.end.line >= inner.range.end.line
  )
}

function keepOutermost(sorted: SgMatch[]): SgMatch[] {
  const kept: SgMatch[] = []
  for (const m of sorted) {
    if (!kept.some(r => contains(r, m))) kept.push(m)
  }
  return kept
}

function dedup(matches: SgMatch[]): SgMatch[] {
  const sorted = [...matches].sort((a, b) => a.file.localeCompare(b.file) || a.range.start.line - b.range.start.line)
  return keepOutermost(sorted)
}

const unique = dedup(matches)

if (updateBaseline) {
  mkdirSync(join(root, '.sg'), { recursive: true })
  const entries = unique.map(m => m.file).sort()
  const dedupedFiles = [...new Set(entries)]
  writeFileSync(baselineFile, `${JSON.stringify(dedupedFiles, null, 2)}\n`)
  console.log(`ast-grep baseline updated: ${dedupedFiles.length} file(s) with ${unique.length} violation(s)`)
  process.exit(0)
}

let baselinedFiles: string[] = []
if (existsSync(baselineFile)) {
  baselinedFiles = JSON.parse(readFileSync(baselineFile, 'utf-8'))
}

const baselineSet = new Set(baselinedFiles)
const newFindings = unique.filter(m => !baselineSet.has(m.file))

if (newFindings.length === 0) {
  const suppressed = unique.length - newFindings.length
  if (suppressed > 0) {
    console.log(`ast-grep: ${suppressed} baselined violation(s) in ${baselineSet.size} file(s), 0 new -- OK`)
  } else {
    console.log('ast-grep: 0 pattern violations -- OK')
  }
  process.exit(0)
}

console.error(`\nast-grep: ${newFindings.length} NEW pattern violation(s)\n`)

for (const m of newFindings) {
  const loc = `${m.file}:${m.range.start.line + 1}`
  console.error(`  ${loc}  [no-long-if-chain]`)
  console.error(`    If-else chain with 4+ branches -- use a strategy map or switch`)
  console.error()
}

if (baselinedFiles.length > 0) {
  console.error(`(${baselinedFiles.length} file(s) baselined -- fix when you touch them)\n`)
}

console.error(
  'Fix: refactor to Record<string, handler> with ?? fallback.\n' +
    'See CLAUDE.md "STRATEGY MAPS OVER CHAINS" covenant.\n' +
    'Baseline a file: bun run lint:patterns -- --update-baseline\n',
)

process.exit(1)
