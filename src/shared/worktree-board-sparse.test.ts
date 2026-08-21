/**
 * A worktree must not hold a copy of the board.
 *
 * `.rclaude/project/` becomes a tracked tree, and a git worktree checks out the
 * tracked tree -- so without this every worktree materialises its own 628-file
 * board that nothing keeps in sync. The shadow is committable (`git add -A`),
 * conflicts on merge over cards nobody edited, and drifts from the first
 * `project_set_status` onward. scripts/worktree-sparse-board.sh sparse-excludes
 * it so the file physically is not there.
 *
 * Every test here drives the REAL script against a REAL throwaway repo. The
 * thing under test is git's own behaviour; asserting against a mock would prove
 * nothing.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { churnBoardOnMain, git, makeBoardFixture, runSparseBoard } from './board-sparse-fixture'

const REPO_ROOT = join(import.meta.dir, '..', '..')
const SCRIPT = join(REPO_ROOT, 'scripts', 'worktree-sparse-board.sh')

const boardCard = (root: string, name: string) => join(root, '.rclaude', 'project', 'cards', name)

describe('worktree-sparse-board.sh', () => {
  test('the fixture proves the bug is real: a fresh worktree DOES get a board copy', () => {
    const fx = makeBoardFixture()
    expect(existsSync(boardCard(fx.wt, 'c1.md'))).toBe(true)
    expect(fx.boardFiles(fx.wt).length).toBe(2)
  })

  test('leaves no board file in the worktree and no live board entry in its index', () => {
    const fx = makeBoardFixture()
    const res = runSparseBoard(SCRIPT, fx.wt, fx.base)

    expect(res.code).toBe(0)
    expect(res.output).toContain('OK ')
    expect(existsSync(boardCard(fx.wt, 'c1.md'))).toBe(false)
    expect(existsSync(boardCard(fx.wt, 'c2.md'))).toBe(false)
    // Still in the index -- flagged skip-worktree, which is what keeps merges
    // correct. "No live entry" is the assertion, not "no entry".
    expect(fx.boardFiles(fx.wt).length).toBe(2)
    expect(fx.liveBoardEntries(fx.wt)).toEqual([])
  })

  test('a worktree can no longer commit a shadow board', () => {
    const fx = makeBoardFixture()
    runSparseBoard(SCRIPT, fx.wt, fx.base)

    expect(fx.status(fx.wt)).toBe('')
    git(['add', '-A'], fx.wt)
    // The whole failure mode in one assertion: `git add -A` stages nothing.
    expect(fx.status(fx.wt)).toBe('')
  })

  test('everything outside the board survives, including the rest of .rclaude/', () => {
    const fx = makeBoardFixture()
    runSparseBoard(SCRIPT, fx.wt, fx.base)

    expect(existsSync(join(fx.wt, 'src', 'a.txt'))).toBe(true)
    expect(existsSync(join(fx.wt, 'README.md'))).toBe(true)
    expect(existsSync(join(fx.wt, '.rclaude', 'rclaude.json'))).toBe(true)

    writeFileSync(join(fx.wt, 'src', 'a.txt'), 'a\nb\n')
    git(['add', '-A'], fx.wt)
    expect(git(['commit', '-qm', 'ordinary work'], fx.wt).code).toBe(0)
    expect(git(['show', '--stat', '--oneline', 'HEAD'], fx.wt).output).toContain('src/a.txt')
  })

  test('board changes still merge in -- into the index, never onto the worktree disk', () => {
    const fx = makeBoardFixture()
    runSparseBoard(SCRIPT, fx.wt, fx.base)
    churnBoardOnMain(fx)

    const merge = git(['merge', 'main', '-m', 'merge main'], fx.wt)
    expect(merge.code).toBe(0)
    // The merge carried the board correctly...
    expect(git(['show', 'HEAD:.rclaude/project/cards/c1.md'], fx.wt).stdout).toBe('c1-edited')
    expect(git(['show', 'HEAD:.rclaude/project/cards/c3.md'], fx.wt).stdout).toBe('c3')
    // ...without putting a single card on this worktree's disk.
    expect(existsSync(boardCard(fx.wt, 'c1.md'))).toBe(false)
    expect(existsSync(boardCard(fx.wt, 'c3.md'))).toBe(false)
    expect(fx.status(fx.wt)).toBe('')
  })

  test('REFUSES the main working tree -- that is where the real board lives', () => {
    const fx = makeBoardFixture()
    const res = runSparseBoard(SCRIPT, fx.base, fx.base)

    expect(res.code).toBe(1)
    expect(res.output).toContain('REFUSED')
    expect(res.output).toContain('MAIN working tree')
    // The 628 cards this guard exists to protect.
    expect(existsSync(boardCard(fx.base, 'c1.md'))).toBe(true)
    expect(existsSync(boardCard(fx.base, 'c2.md'))).toBe(true)
    expect(git(['config', '--get', 'core.sparseCheckout'], fx.base).stdout).toBe('')
  })

  test('is idempotent -- rerunning changes nothing', () => {
    const fx = makeBoardFixture()
    expect(runSparseBoard(SCRIPT, fx.wt, fx.base).code).toBe(0)
    const second = runSparseBoard(SCRIPT, fx.wt, fx.base)

    expect(second.code).toBe(0)
    expect(fx.liveBoardEntries(fx.wt)).toEqual([])
    expect(git(['sparse-checkout', 'list'], fx.wt).stdout).toBe('/*\n!/.rclaude/project/')
  })

  test('never destroys uncommitted work: reports the file and leaves the edit alone', () => {
    // Other agents are living in these trees right now. A sweep that eats their
    // in-progress edit is worse than the shadow it removes.
    const fx = makeBoardFixture()
    writeFileSync(boardCard(fx.wt, 'c1.md'), 'c1\nLOCAL EDIT\n')

    const res = runSparseBoard(SCRIPT, fx.wt, fx.base)

    expect(res.code).toBe(2)
    expect(res.output).toContain('PARTIAL')
    expect(res.output).toContain('c1.md')
    expect(readFileSync(boardCard(fx.wt, 'c1.md'), 'utf8')).toBe('c1\nLOCAL EDIT\n')
    // The clean sibling still got swept.
    expect(existsSync(boardCard(fx.wt, 'c2.md'))).toBe(false)
  })

  test('--all sweeps the project worktrees and never the main checkout', () => {
    const fx = makeBoardFixture()
    const second = join(fx.base, '.claude', 'worktrees', 'other')
    git(['worktree', 'add', '-q', '-b', 'worktree-other', second], fx.base)

    const res = runSparseBoard(SCRIPT, '--all', fx.base)

    expect(res.code).toBe(0)
    expect(res.output).toContain('swept 2 worktree(s) clean, 0 left board files')
    expect(fx.liveBoardEntries(fx.wt)).toEqual([])
    expect(fx.liveBoardEntries(second)).toEqual([])
    expect(existsSync(boardCard(fx.base, 'c1.md'))).toBe(true)
  })

  test('--all reports a worktree it could not sweep BY NAME instead of forcing it', () => {
    const fx = makeBoardFixture()
    writeFileSync(boardCard(fx.wt, 'c1.md'), 'c1\nLOCAL EDIT\n')

    const res = runSparseBoard(SCRIPT, '--all', fx.base)

    expect(res.code).toBe(2)
    expect(res.output).toContain('1 left board files')
    expect(res.output).toContain(fx.wt)
  })
})

describe('the hook still calls it', () => {
  test('worktree-init.sh invokes worktree-sparse-board.sh', () => {
    // Deleting the call is a silent regression: worktrees start carrying the
    // board again and nothing fails until a shadow gets committed.
    const init = readFileSync(join(REPO_ROOT, 'worktree-init.sh'), 'utf8')
    expect(init).toContain('worktree-sparse-board.sh')
    expect(init).toContain('"$WORKTREE"')
  })
})
