#!/usr/bin/env bun

/**
 * Protocol-contract lint: every wire message declared in `src/shared/protocol.ts`
 * must actually be referenced on the wire somewhere outside protocol.ts.
 *
 * Why this exists: `protocol.ts` is a WIRE CONTRACT surface, not an app module.
 * Import-graph dead-code tools (fallow) judge an export by "is it imported",
 * which is the wrong liveness test here -- handlers parse messages as
 * `Record<string, unknown>` and dispatch on the `type` string literal, so a
 * fully-live message type has zero importers. Fallow flagged 38 such types as
 * dead in 2026-07; every single one was live on the wire. Deleting them would
 * have deleted the documentation of the live protocol.
 *
 * So protocol.ts is exempted from fallow's unused-export/type check (see
 * `.fallowrc.json` -> ignoreExports) and THIS check replaces it with the
 * invariant that actually holds: a declared message whose `type` literal
 * appears nowhere else in the tree is genuinely dead and should be removed.
 *
 * Non-message exports in protocol.ts (payload shapes, helper constants) are NOT
 * covered by either check -- audit those by hand when touching them.
 *
 * Run: `bun run scripts/lint-protocol-contract.ts`
 * Exits 0 = clean, 1 = violations found.
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Glob } from 'bun'

const ROOT = join(import.meta.dir, '..')
const PROTOCOL = 'src/shared/protocol.ts'
const SCAN_DIRS = ['src', 'web/src', 'packages', 'scripts']

// `export interface Foo {` / `export type Foo = {`
const DECL = /^export (?:interface|type) ([A-Z][\w$]*)\b/
// The discriminant field: `type: 'foo_bar'` or `type?: 'foo_bar'`
const DISCRIMINANT = /^\s*type\??:\s*'([a-z0-9_]+)'/m
// How far past a declaration to look for the discriminant before giving up.
const LOOKAHEAD = 12

interface WireMessage {
  name: string
  literal: string
  line: number
}

/** Lines belonging to the declaration at `start` (stops at the next declaration). */
function blockLines(lines: string[], start: number): string[] {
  const block = lines.slice(start, start + LOOKAHEAD)
  const next = block.findIndex((line, k) => k > 0 && DECL.test(line))
  return next === -1 ? block : block.slice(0, next)
}

/** The `type: '...'` literal for the block starting at `start`, if it has one. */
function findDiscriminant(lines: string[], start: number): string | null {
  const hit = DISCRIMINANT.exec(blockLines(lines, start).join('\n'))
  return hit === null ? null : hit[1]
}

function collectMessages(source: string): WireMessage[] {
  const lines = source.split('\n')
  const found: WireMessage[] = []
  for (let i = 0; i < lines.length; i++) {
    const decl = DECL.exec(lines[i])
    if (!decl) continue
    const literal = findDiscriminant(lines, i)
    if (literal) found.push({ name: decl[1], literal, line: i + 1 })
  }
  return found
}

function readDir(dir: string): string[] {
  const abs = join(ROOT, dir)
  const glob = new Glob('**/*.{ts,tsx}')
  const out: string[] = []
  for (const rel of glob.scanSync({ cwd: abs, absolute: false })) {
    const path = join(dir, rel)
    if (path === PROTOCOL || path.includes('node_modules')) continue
    out.push(readFileSync(join(abs, rel), 'utf8'))
  }
  return out
}

function loadTree(): string {
  return SCAN_DIRS.flatMap(readDir).join('\n')
}

const protocolSource = readFileSync(join(ROOT, PROTOCOL), 'utf8')
const messages = collectMessages(protocolSource)

// Guard the vacuous pass: if the declaration style in protocol.ts ever drifts
// away from what DECL/DISCRIMINANT match, this lint would silently find zero
// messages and "pass" forever. A protocol with almost no messages is not a
// real state of this repo -- treat it as a broken parser, not a clean run.
const SANITY_FLOOR = 50
if (messages.length < SANITY_FLOOR) {
  console.error(
    `\nprotocol-contract: only ${messages.length} wire message(s) parsed from ${PROTOCOL} ` +
      `(expected >= ${SANITY_FLOOR}).\nThe declaration style likely drifted -- fix the DECL / DISCRIMINANT patterns in this script.\n`,
  )
  process.exit(1)
}

const tree = loadTree()

const dead = messages.filter(m => !new RegExp(`\\b${m.literal}\\b`).test(tree))

if (dead.length === 0) {
  console.log(`protocol-contract: ${messages.length} wire message(s), all referenced -- OK`)
  process.exit(0)
}

console.error(`\nprotocol-contract: ${dead.length} declared wire message(s) with NO reference outside ${PROTOCOL}\n`)
for (const m of dead) {
  console.error(`  ${PROTOCOL}:${m.line}  ${m.name}`)
  console.error(`    type: '${m.literal}' -- never sent, handled, or matched anywhere in the tree`)
  console.error()
}
console.error(
  'Either the message is genuinely dead (delete the interface), or it is newly\n' +
    'added and its handler/sender has not landed yet (land them in the same change).\n',
)

process.exit(1)
