import { afterAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { evaluate, type Roots } from './probe'
import type { Aspect } from './types'

const root = mkdtempSync(join(tmpdir(), 'wall-verify-'))
const roots: Roots = { code: root, board: root }
afterAll(() => rmSync(root, { recursive: true, force: true }))

function card(id: string, status: string): void {
  const dir = join(root, '.rclaude/project/cards')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, `${id}.md`), `---\ntitle: "${id}"\nstatus: ${status}\n---\n\nbody\n`)
}
function src(rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}
const aspect = (over: Partial<Aspect>): Aspect => ({
  code: 'X',
  card: 'c',
  promise: 'p',
  artifacts: [{ path: 'src/thing.ts' }],
  ...over,
})

describe('wall-verify verdicts', () => {
  test('a card that is not on the board is MISSING, never quietly pending', () => {
    const r = evaluate(roots, aspect({ card: 'nope' }))
    expect(r.verdict).toBe('MISSING')
    expect(r.failures[0]).toContain('not on the board')
  })

  test('an open card with nothing built is PENDING, and stays quiet', () => {
    card('open-card', 'open')
    const r = evaluate(roots, aspect({ card: 'open-card' }))
    expect(r.verdict).toBe('PENDING')
  })

  test('a done card whose artifact is absent is MISSING -- the false-done case', () => {
    card('done-card', 'done')
    const r = evaluate(roots, aspect({ card: 'done-card' }))
    expect(r.verdict).toBe('MISSING')
    expect(r.failures[0]).toContain('card is done but absent')
  })

  test('a done card with its artifact present is VERIFIED', () => {
    card('good-card', 'done')
    src('src/thing.ts', 'export const thing = 1\n')
    const r = evaluate(roots, aspect({ card: 'good-card' }))
    expect(r.verdict).toBe('VERIFIED')
    expect(r.passed).toBe(r.total)
  })

  test('an artifact that exists but lacks its needle does NOT count as delivered', () => {
    card('needle-card', 'done')
    src('src/needle.ts', 'export const other = 1\n')
    const r = evaluate(
      roots,
      aspect({ card: 'needle-card', artifacts: [{ path: 'src/needle.ts', needle: 'useWallCursor' }] }),
    )
    expect(r.verdict).toBe('MISSING')
  })

  test('in-review is NOT settled -- work on an unmerged branch is not a broken promise', () => {
    card('review-card', 'in-review')
    const r = evaluate(roots, aspect({ card: 'review-card', artifacts: [{ path: 'src/unmerged.ts' }] }))
    expect(r.verdict).toBe('PENDING')
  })

  test('a dead feed WITH an owner still building it is BLOCKED, not an alarm', () => {
    card('consumer', 'open')
    card('feed-owner', 'in-progress')
    const r = evaluate(
      roots,
      aspect({ card: 'consumer', feeds: [{ path: 'src/absent-feed.ts' }], feedFrom: 'feed-owner' }),
    )
    expect(r.verdict).toBe('BLOCKED')
    expect(r.failures[0]).toContain('is building it')
  })

  test('a dead feed with NOBODY on it is UNDELIVERABLE -- this is the loud one', () => {
    card('orphan', 'open')
    const r = evaluate(roots, aspect({ card: 'orphan', feeds: [{ path: 'src/absent-feed.ts' }] }))
    expect(r.verdict).toBe('UNDELIVERABLE')
    expect(r.failures[0]).toContain('NOBODY is building it')
  })

  test('a feed whose owner already finished, yet is still absent, is UNDELIVERABLE', () => {
    card('consumer2', 'open')
    card('finished-owner', 'done')
    const r = evaluate(
      roots,
      aspect({ card: 'consumer2', feeds: [{ path: 'src/absent-feed.ts' }], feedFrom: 'finished-owner' }),
    )
    expect(r.verdict).toBe('UNDELIVERABLE')
  })

  test('a dead feed outranks a settled card -- no false PASS on a real gap', () => {
    card('settled', 'done')
    src('src/thing.ts', 'export const thing = 1\n')
    const r = evaluate(roots, aspect({ card: 'settled', feeds: [{ path: 'src/absent-feed.ts' }] }))
    expect(r.verdict).toBe('UNDELIVERABLE')
  })

  test('globs match, so a pinned symbol can live in any file under a directory', () => {
    card('glob-card', 'done')
    src('web/src/components/wall/wall-surface.tsx', 'export const x = useManagedModal()\n')
    const r = evaluate(
      roots,
      aspect({
        card: 'glob-card',
        artifacts: [{ path: 'web/src/components/wall/**/*.tsx', needle: 'useManagedModal' }],
      }),
    )
    expect(r.verdict).toBe('VERIFIED')
  })
})
