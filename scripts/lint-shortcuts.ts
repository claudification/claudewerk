#!/usr/bin/env bun

/**
 * Shortcut lint: no two commands may claim the same keybinding.
 *
 * WHY THIS EXISTS (2026-08-18): Pulse shipped bound to the chord `mod+k p`,
 * which `open-project` (Open Kanban board) already owned. Nothing complained --
 * `validateChordBindings()` in web/src/lib/commands.ts only looked for PREFIX
 * conflicts (`mod+k s` vs `mod+k s e`), so two commands claiming the IDENTICAL
 * binding were silently accepted and the winner decided by registration order.
 * A human pressing the keys found it.
 *
 * A runtime warning nobody reads is not a gate. This is static: it reads the
 * source, so a colliding binding fails the build before it can ship.
 *
 * The scanning + collision logic lives in scripts/lib/shortcut-scan.ts (pure,
 * unit-tested); this file is the CLI around it.
 *
 * Run: `bun run lint:shortcuts`   Exits 0 = clean, 1 = collisions found.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { type Binding, findCollisions, formatCollisions, scanBindings } from './lib/shortcut-scan'

const ROOT = join(import.meta.dir, '..')
const SCAN_DIR = join(ROOT, 'web/src')
const BASELINE = join(import.meta.dir, 'shortcut-baseline.json')

// fallow-ignore-next-line complexity -- plain recursive dir walk; the logic worth testing lives in ./lib/shortcut-scan.ts, which is tested
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

interface BaselineFile {
  duplicates: Array<{ shortcut: string }>
  prefixes: Array<{ shortcut: string }>
}
const baseline: BaselineFile = JSON.parse(readFileSync(BASELINE, 'utf8'))

const bindings: Binding[] = walk(SCAN_DIR).flatMap(file =>
  scanBindings(readFileSync(file, 'utf8'), file.slice(ROOT.length + 1)),
)

const collisions = findCollisions(bindings, {
  duplicates: new Set(baseline.duplicates.map(d => d.shortcut)),
  prefixes: new Set(baseline.prefixes.map(p => p.shortcut)),
})

if (!collisions.length) {
  console.log(`[shortcut-lint] PASS -- ${bindings.length} bindings, no collisions`)
  process.exit(0)
}

console.error(`[shortcut-lint] FAIL\n\n${formatCollisions(collisions)}`)
console.error('Pick a free binding. A passing run prints the total so you can see what is taken.\n')
process.exit(1)
