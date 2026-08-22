/**
 * The CLI's REFUSALS, not the rename -- `werk-tag-rename.test.ts` already owns
 * the decision about what a card's text becomes.
 *
 * What is tested here is the thing that made this script dangerous: it used to
 * WRITE by default, against `cwd` by default, on a migration whose whole hazard
 * is running it at the wrong moment against the wrong board. So these drive the
 * real script as a subprocess against a temp board, because the flag policy and
 * the exit codes ARE the surface -- a unit test of an exported `main` would not
 * have caught a `process.exit` that fired before the guard.
 */

import { describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SCRIPT = new URL('./migrate-werk-tags.ts', import.meta.url).pathname

const CARD = `---
title: "a question nobody answered"
status: open
tags: [werk, needs-overseer]
---

Body prose mentioning \`needs-overseer\` stays exactly as written.
`

/** A throwaway project root with one card carrying the old tag. */
function board(): { root: string; card: string } {
  const root = mkdtempSync(join(tmpdir(), 'werk-tags-'))
  const dir = join(root, '.rclaude', 'project', 'cards')
  mkdirSync(dir, { recursive: true })
  const card = join(dir, 'q1.md')
  writeFileSync(card, CARD)
  return { root, card }
}

async function run(args: string[], cwd?: string) {
  const proc = Bun.spawn(['bun', 'run', SCRIPT, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout, stderr, code }
}

describe('the safe form is the default', () => {
  test('no flags writes NOTHING, and says how to actually do it', async () => {
    const { root, card } = board()
    const { stdout, code } = await run(['--root', root])
    expect(code).toBe(0)
    expect(stdout).toContain('would rewrite q1.md')
    expect(stdout).toContain('before: 1 card(s)')
    expect(stdout).toContain('--apply')
    // THE ASSERTION THAT MATTERS: the file on disk is byte-identical.
    expect(readFileSync(card, 'utf8')).toBe(CARD)
  })

  test('--apply without --root refuses rather than migrating whatever cwd is', async () => {
    const { root, card } = board()
    const { stderr, code } = await run(['--apply'], root)
    expect(code).toBe(2)
    expect(stderr).toContain('--root')
    expect(readFileSync(card, 'utf8')).toBe(CARD)
  })

  test('--apply and --dry-run together is a refusal, never a silent winner', async () => {
    const { root, card } = board()
    const { stderr, code } = await run(['--root', root, '--apply', '--dry-run'])
    expect(code).toBe(2)
    expect(stderr).toContain('opposite')
    expect(readFileSync(card, 'utf8')).toBe(CARD)
  })
})

describe('the destructive form', () => {
  test('rewrites the frontmatter tag, leaves the body prose alone, counts both ends', async () => {
    const { root, card } = board()
    const { stdout, code } = await run(['--root', root, '--apply'])
    expect(code).toBe(0)
    const text = readFileSync(card, 'utf8')
    expect(text).toContain('tags: [werk, needs-werk-master]')
    expect(text).toContain('Body prose mentioning `needs-overseer` stays exactly as written.')
    expect(stdout).toContain('before: 1 card(s)')
    expect(stdout).toContain('after:  0 card(s)')
  })

  test('a board already migrated is a no-op that still reports both counts', async () => {
    const { root } = board()
    await run(['--root', root, '--apply'])
    const { stdout, code } = await run(['--root', root, '--apply'])
    expect(code).toBe(0)
    expect(stdout).toContain('before: 0 card(s)')
    expect(stdout).toContain('after:  0 card(s)')
  })

  test('a root with no board is an error, not a silent success', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'werk-tags-empty-'))
    const { stderr, code } = await run(['--root', empty, '--apply'])
    expect(code).toBe(2)
    expect(stderr).toContain('no card store')
  })
})
