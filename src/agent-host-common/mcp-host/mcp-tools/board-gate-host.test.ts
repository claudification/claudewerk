import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseFrontmatter } from '../../../shared/frontmatter'
import { cmdRunner, writeGateEvidence } from './board-gate-host'

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
  writeGateEvidence(abs, parseFrontmatter(readFileSync(abs, 'utf8')), evidence)
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
    expect(() =>
      writeGateEvidence(missing, { meta: { title: 'T' }, body: 'body', raw: {} }, { evidence_tests: 'pass' }),
    ).not.toThrow()
  })

  test('a nested `promise:` block survives the evidence stamp byte-for-byte', () => {
    // The gate stamps evidence at the DONE move -- the one moment a card is most
    // likely to be carrying a `closes:` list. Flattening it here would empty the
    // ledger at exactly the transition it exists to audit.
    const out = stamp(
      ['title: T', 'status: in-review', 'promise:', '  agreed: 2026-08-21', '  closes:', '    - 83bf55f0'],
      { evidence_worker: 'conv_1' },
    )
    expect(out).toContain('promise:\n  agreed: 2026-08-21\n  closes:\n    - 83bf55f0\n')
    expect(out).toContain('evidence_worker: conv_1')
  })
})

describe('cmdRunner does not freeze the MCP host', () => {
  /** Count event-loop turns while `run` is in flight. `Bun.spawnSync` scores 0 --
   *  that zero IS the bug: no other tool call is serviced for the whole suite. */
  async function ticksDuring<T>(work: () => Promise<T>): Promise<{ ticks: number; result: T }> {
    let ticks = 0
    const timer = setInterval(() => {
      ticks++
    }, 10)
    try {
      return { result: await work(), ticks }
    } finally {
      clearInterval(timer)
    }
  }

  test('a slow test_cmd yields the event loop instead of blocking it', async () => {
    const run = cmdRunner(dir)
    const { ticks, result } = await ticksDuring(() => run('sleep 0.4', 30_000))
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    // ~40 turns available in 400ms; anything above a handful proves we yielded.
    expect(ticks).toBeGreaterThan(5)
  })

  test('captures stdout AND stderr, in that order, with the real exit code', async () => {
    const r = await cmdRunner(dir)('echo out; echo err >&2; exit 3', 30_000)
    expect(r.exitCode).toBe(3)
    expect(r.output).toBe('out\nerr\n')
    expect(r.timedOut).toBe(false)
  })

  test('runs in the given cwd', async () => {
    const r = await cmdRunner(dir)('pwd', 30_000)
    expect(r.exitCode).toBe(0)
    // macOS hands back /private/var/... for a /var/... tmpdir; suffix is enough.
    expect(r.output.trim().endsWith(dir.replace(/^\/private/, ''))).toBe(true)
  })

  test('a hung command is killed at the deadline and reported as timedOut', async () => {
    const started = performance.now()
    const r = await cmdRunner(dir)('sleep 30', 300)
    expect(r.timedOut).toBe(true)
    expect(r.exitCode).toBe(-1)
    expect(performance.now() - started).toBeLessThan(10_000)
  })
})
