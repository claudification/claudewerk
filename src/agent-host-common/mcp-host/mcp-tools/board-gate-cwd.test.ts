/**
 * REGRESSION: the DONE-gate must measure the WORKER'S worktree, not the project
 * root it was handed as `dialogCwd`.
 *
 * A real repo with a real `git worktree` -- the bug is entirely about which
 * checkout git and `test_cmd` run in, so faking git would fake the bug away.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gateTransition } from './board-gate-host'

const CARD_ID = 'my-card'
let root: string
let worktree: string

function git(cwd: string, ...args: string[]): void {
  const p = Bun.spawnSync(['git', '-C', cwd, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (p.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed: ${new TextDecoder().decode(p.stderr)}`)
}

function cardPath(): string {
  return join(root, '.rclaude', 'project', 'cards', `${CARD_ID}.md`)
}

function writeCard(extraFrontmatter: string[] = []): void {
  mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(
    cardPath(),
    `---\ntitle: T\nstatus: in-progress\n${extraFrontmatter.join('\n')}${extraFrontmatter.length ? '\n' : ''}---\n\nbody\n`,
    'utf8',
  )
}

function setGateMode(mode: string): void {
  mkdirSync(join(root, '.rclaude', 'project'), { recursive: true })
  writeFileSync(join(root, '.rclaude', 'project', 'gate.conf'), `${mode}\n`, 'utf8')
}

function transition(targetStatus: 'in-review' | 'done', over: Record<string, unknown> = {}) {
  return gateTransition({
    dialogCwd: root,
    cardId: CARD_ID,
    cardPath: cardPath(),
    fromStatus: 'in-progress',
    targetStatus,
    actingConversationId: 'conv_worker',
    nowMs: 0,
    ...over,
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'gate-cwd-'))
  git(root, 'init', '-b', 'main', '-q')
  git(root, 'config', 'user.email', 't@t.t')
  git(root, 'config', 'user.name', 'T')
  writeFileSync(join(root, 'seed.txt'), 'seed\n', 'utf8')
  git(root, 'add', 'seed.txt')
  git(root, 'commit', '-qm', 'seed')

  // The worker's worktree, named after the card exactly as worktree-create.sh does.
  worktree = join(root, '.claude', 'worktrees', 'epic', 'some-epic', CARD_ID)
  mkdirSync(join(root, '.claude', 'worktrees', 'epic', 'some-epic'), { recursive: true })
  git(root, 'worktree', 'add', '-q', '-b', `worktree-${CARD_ID}`, worktree)
  writeFileSync(join(worktree, 'work.txt'), 'real work\n', 'utf8')
  git(worktree, 'add', 'work.txt')
  git(worktree, 'commit', '-qm', 'the work')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("the gate measures the card's worktree, not the project root", () => {
  test('root has nothing to show -- this is what the gate used to see', () => {
    const p = Bun.spawnSync(['git', '-C', root, 'rev-list', '--count', 'main..HEAD'], { stdout: 'pipe' })
    expect(new TextDecoder().decode(p.stdout).trim()).toBe('0')
  })

  test('in-review under tier2 allows and stamps the WORKTREE branch + commits', async () => {
    setGateMode('tier2')
    writeCard()
    const { outcome, gitCwd, cwdNote } = await transition('in-review')

    expect(cwdNote).toBe('worktree')
    expect(gitCwd).toContain(join('.claude', 'worktrees', 'epic', 'some-epic', CARD_ID))
    expect(outcome.decision).toBe('allow')
    expect(outcome.evidence.evidence_branch).toBe(`worktree-${CARD_ID}`)
    expect(outcome.evidence.evidence_commits).toBe(1)
    expect(String(outcome.evidence.evidence_diffstat)).toContain('1 file changed')
    expect(outcome.evidence.evidence_worker).toBe('conv_worker')
  })

  test('the evidence actually lands in the card frontmatter', async () => {
    setGateMode('tier2')
    writeCard()
    await transition('in-review')
    const card = readFileSync(cardPath(), 'utf8')
    expect(card).toContain(`evidence_branch: worktree-${CARD_ID}`)
    expect(card).toContain('evidence_commits: 1')
    expect(card).toContain('evidence_worker: conv_worker')
  })

  test('test_cmd runs INSIDE the worktree, not the root', async () => {
    setGateMode('tier2')
    writeCard(['test_cmd: test -f work.txt'])
    const { outcome } = await transition('in-review')
    expect(outcome.decision).toBe('allow')
    expect(outcome.evidence.evidence_tests).toBe('pass')
    // `work.txt` exists only in the worktree -- a root-run test_cmd would exit 1.
    expect(existsSync(join(root, 'work.txt'))).toBe(false)
  })

  test('a dirty WORKTREE is refused even though the root is clean', async () => {
    setGateMode('tier2')
    writeCard()
    writeFileSync(join(worktree, 'scratch.txt'), 'uncommitted\n', 'utf8')
    const { outcome } = await transition('in-review')
    expect(outcome.decision).toBe('refuse')
    expect(outcome.reason).toContain('tree dirty')
  })

  test('no worktree for the card -> the project root, i.e. the old behaviour', async () => {
    setGateMode('tier2')
    mkdirSync(join(root, '.rclaude', 'project', 'cards'), { recursive: true })
    const otherPath = join(root, '.rclaude', 'project', 'cards', 'other-card.md')
    writeFileSync(otherPath, '---\ntitle: T\nstatus: in-progress\n---\n\nbody\n', 'utf8')
    const { gitCwd, cwdNote, outcome } = await gateTransition({
      dialogCwd: root,
      cardId: 'other-card',
      cardPath: otherPath,
      fromStatus: 'in-progress',
      targetStatus: 'in-review',
      actingConversationId: 'conv_worker',
      nowMs: 0,
    })
    expect(cwdNote).toBe('no-worktree')
    expect(gitCwd).not.toContain('.claude/worktrees')
    expect(outcome.decision).toBe('refuse')
    expect(outcome.reason).toContain('no commits since main')
  })

  test('gate off -> skip, and nothing is written to the card', async () => {
    writeCard()
    const before = readFileSync(cardPath(), 'utf8')
    const { outcome } = await transition('in-review')
    expect(outcome.decision).toBe('skip')
    expect(outcome.mode).toBe('off')
    expect(readFileSync(cardPath(), 'utf8')).toBe(before)
  })
})

/**
 * The per-card `gate:` override is the zero-blast-radius way to exercise the real
 * Tier-1 + Tier-2 path (`resolveGateMode` checks it AHEAD of the project config),
 * so this is where the full worker -> verifier handshake is proven end to end
 * against a real repo, with no `.rclaude/project/gate.conf` anywhere.
 */
describe('the full worker -> verifier handshake, on a per-card `gate: full`', () => {
  test('worker captures, an independent verifier approves, and the verdict lands on disk', async () => {
    writeCard(['gate: full'])

    const captured = await transition('in-review', { actingConversationId: 'conv_worker' })
    expect(captured.outcome.mode).toBe('full')
    expect(captured.outcome.decision).toBe('allow')
    expect(captured.outcome.evidence.evidence_worker).toBe('conv_worker')

    const approved = await transition('done', { fromStatus: 'in-review', actingConversationId: 'conv_guard' })
    expect(approved.outcome.decision).toBe('allow')
    expect(approved.outcome.evidence.verdict).toBe('APPROVED by conv_guard')

    const card = readFileSync(cardPath(), 'utf8')
    expect(card).toContain('verdict: APPROVED by conv_guard')
    expect(card).toContain('evidence_worker: conv_worker')
    expect(card).toContain('evidence_verified_at:')
  })

  test('the worker cannot approve its own card', async () => {
    writeCard(['gate: full'])
    await transition('in-review', { actingConversationId: 'conv_worker' })
    const self = await transition('done', { fromStatus: 'in-review', actingConversationId: 'conv_worker' })
    expect(self.outcome.decision).toBe('refuse')
    expect(self.outcome.reason).toContain('self-approval refused')
    expect(readFileSync(cardPath(), 'utf8')).not.toContain('verdict:')
  })

  test('a per-card override needs no project gate.conf -- the board stays off around it', async () => {
    writeCard(['gate: full'])
    expect(existsSync(join(root, '.rclaude', 'project', 'gate.conf'))).toBe(false)
    expect((await transition('in-review')).outcome.mode).toBe('full')

    // The card next door, with no override, is still ungated.
    const plain = join(root, '.rclaude', 'project', 'cards', 'plain.md')
    writeFileSync(plain, '---\ntitle: T\nstatus: in-progress\n---\n\nbody\n', 'utf8')
    const out = await gateTransition({
      dialogCwd: root,
      cardId: 'plain',
      cardPath: plain,
      fromStatus: 'in-progress',
      targetStatus: 'in-review',
      actingConversationId: 'conv_worker',
      nowMs: 0,
    })
    expect(out.outcome.mode).toBe('off')
    expect(out.outcome.decision).toBe('skip')
  })
})
