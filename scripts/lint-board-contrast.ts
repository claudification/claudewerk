#!/usr/bin/env bun

/**
 * The project board's text may not sit below the WCAG AA floor.
 *
 * WHY (2026-08-15): the board read as grey-on-grey, and two rounds of nudging
 * individual spots did not fix it because the FLOOR was never set. An audit
 * found 44 of 63 `text-muted-foreground/*` usages under 4.5:1 -- nineteen of
 * them `/40`. Anything that gets fixed by hand and is not enforced comes back,
 * one plausible-looking `/40` at a time.
 *
 * This is a string-content check, not an AST shape, which is why it is its own
 * script rather than another `lint-patterns.ts` rule.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')

/** Measured against the panel's own tokens -- see board-constants.ts. */
const FLOOR = 55

const LADDER = [
  '  /25 -> 2.59   /35 -> 3.23   /40 -> 3.55   /50 -> 4.18',
  '  /55 -> 4.50 (AA floor)   /60 -> 4.82   /70 -> 5.46   /85 -> 6.41',
  '',
  '  Background oklch(0.15 0.02 260), --muted-foreground oklch(0.7 0.02 260).',
  '  Board text is 9-13px = SMALL text, so it owes 4.5:1. The 3:1 large-text',
  '  allowance does not apply anywhere on this board.',
].join('\n')

/**
 * Non-text below the floor is legal (WCAG 1.4.11 wants 3:1 for UI parts).
 * Mark it so the exemption is a decision on the record, not a gap.
 *
 * Two spellings because a JSX attribute cannot hold a comment: same-line where
 * that works, `-next-line` otherwise. Matches `fallow-ignore-next-line` and
 * `react-doctor-disable-next-line` already in this repo.
 */
const OPT_OUT = 'contrast-decor'
const OPT_OUT_NEXT = 'contrast-decor-next-line'

const TARGETS = [
  'web/src/components/project-board.tsx',
  ...readdirSync(join(ROOT, 'web/src/components/project-board'))
    .filter(f => f.endsWith('.tsx') && !f.endsWith('.test.tsx'))
    .map(f => `web/src/components/project-board/${f}`),
]

/** `text-muted-foreground/40`. Background utilities are excluded: a `bg-` is a
 *  surface, judged as a UI component, not as text. */
const TEXT_ALPHA = /\btext-muted-foreground\/(\d{1,3})\b/g

interface Finding {
  file: string
  line: number
  cls: string
  ratio: string
}

const findings: Finding[] = []

for (const rel of TARGETS) {
  const abs = join(ROOT, rel)
  let source: string
  try {
    source = readFileSync(abs, 'utf-8')
  } catch {
    continue
  }

  findings.push(...scan(relative(ROOT, abs), source.split('\n')))
}

function exempt(lines: string[], i: number): boolean {
  return lines[i].includes(OPT_OUT) || (i > 0 && lines[i - 1].includes(OPT_OUT_NEXT))
}

function scan(file: string, lines: string[]): Finding[] {
  return lines.flatMap((line, i) =>
    exempt(lines, i)
      ? []
      : [...line.matchAll(TEXT_ALPHA)]
          .filter(m => Number(m[1]) < FLOOR)
          .map(m => ({ file, line: i + 1, cls: m[0], ratio: estimate(Number(m[1])) })),
  )
}

/** Rough contrast for the message. The exact table lives in the ladder above;
 *  this just has to make the number feel real at the call site. */
function estimate(alpha: number): string {
  const table: Record<number, string> = { 10: 1.6, 20: 2.3, 25: 2.59, 30: 2.9, 35: 3.23, 40: 3.55, 45: 3.87, 50: 4.18 }
  const nearest = Object.keys(table)
    .map(Number)
    .reduce((a, b) => (Math.abs(b - alpha) < Math.abs(a - alpha) ? b : a))
  return `~${table[nearest]}:1`
}

if (findings.length === 0) {
  console.log(`board-contrast: all board text at or above /${FLOOR} -- OK`)
  process.exit(0)
}

console.error(`\nboard-contrast: ${findings.length} board text style(s) below the AA floor\n`)
for (const f of findings) {
  console.error(`  ${f.file}:${f.line}`)
  console.error(`    ${f.cls}  ->  ${f.ratio}, needs 4.5:1`)
}
console.error(`\n${LADDER}\n`)
console.error(
  `Fix: raise it to at least /${FLOOR}. Use /60 for quiet metadata, /80 for anything\n` +
    `read as content, text-foreground/85 for primary copy.\n` +
    `If it is genuinely NOT text (a rule, a track, filler punctuation), put\n` +
    `\`${OPT_OUT}\` in a comment on that line and keep it at or above /35.\n`,
)
process.exit(1)
