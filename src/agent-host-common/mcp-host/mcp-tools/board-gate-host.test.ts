import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../../../shared/frontmatter'
import { writeGateEvidence } from './board-gate-host'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'gate-host-'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Write a card, stamp evidence onto it the way gateTransition does, hand back
 *  what landed on disk. */
function stamp(frontmatter: string[], evidence: Record<string, unknown>, body = 'the body'): string {
  const abs = join(dir, 'card.md')
  writeFileSync(abs, `---\n${frontmatter.join('\n')}\n---\n\n${body}\n`, 'utf8')
  const parsed = parseFrontmatter(readFileSync(abs, 'utf8'))
  writeGateEvidence(abs, parsed.meta, parsed.body, evidence)
  return readFileSync(abs, 'utf8')
}

const frontmatterOf = (file: string): string[] => file.split('\n---')[0].split('\n').slice(1)
const keysOf = (file: string): string[] => frontmatterOf(file).map(l => l.split(':')[0])

describe('the gate writes through serializeCard, not raw frontmatter', () => {
  test('linkage ALIASES collapse -- blocked_by becomes depends_on', () => {
    const out = stamp(['title: T', 'status: in-review', 'depends_on: [a]', 'blocked_by: [b]'], {
      evidence_worker: 'conv_1',
    })
    expect(out).not.toContain('blocked_by')
    expect(out).toContain('depends_on: [a, b]')
  })

  test('see_also collapses onto relates_to the same way', () => {
    const out = stamp(['title: T', 'status: in-review', 'see_also: [x]'], { evidence_worker: 'conv_1' })
    expect(out).not.toContain('see_also')
    expect(out).toContain('relates_to: [x]')
  })

  test('ORDERED_KEYS holds -- store keys first, in their canonical order', () => {
    const out = stamp(['created: 2026-01-01T00:00:00.000Z', 'status: in-review', 'title: T', 'priority: high'], {
      evidence_worker: 'conv_1',
    })
    expect(keysOf(out)).toEqual(['title', 'status', 'priority', 'created', 'evidence_worker'])
  })

  test('PRESERVE-UNKNOWN-KEYS holds -- the existing evidence bag survives a re-stamp', () => {
    const out = stamp(
      [
        'title: T',
        'status: in-review',
        'gate: tier2',
        'test_cmd: bun test',
        'base: main',
        'evidence_branch: worktree-old',
        'evidence_commits: [abc123]',
      ],
      { evidence_worker: 'conv_1', evidence_tests: 'pass' },
    )
    expect(out).toContain('gate: tier2')
    expect(out).toContain('test_cmd: bun test')
    expect(out).toContain('base: main')
    expect(out).toContain('evidence_commits: [abc123]')
    expect(out).toContain('evidence_worker: conv_1')
    expect(out).toContain('evidence_tests: pass')
  })

  test('new evidence overwrites the stale value for the same key', () => {
    const out = stamp(['title: T', 'status: in-review', 'evidence_tests: fail'], { evidence_tests: 'pass' })
    expect(out).toContain('evidence_tests: pass')
    expect(out).not.toContain('evidence_tests: fail')
  })

  test('the body is untouched', () => {
    const out = stamp(['title: T', 'status: in-review'], { evidence_worker: 'conv_1' }, 'line one\n\nline two')
    expect(out).toContain('line one\n\nline two')
  })

  test('an unwritable card never throws -- the stamp is best-effort, the move proceeds', () => {
    const missing = join(dir, 'no', 'such', 'card.md')
    expect(() => writeGateEvidence(missing, { title: 'T' }, 'body', { evidence_tests: 'pass' })).not.toThrow()
  })
})
