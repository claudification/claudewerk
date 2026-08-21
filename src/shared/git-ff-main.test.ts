/**
 * fastForwardMain() is Layer 3 of the merge-back defense -- the agent host runs
 * it on ad-hoc session exit. It used to be a bare `git fetch . HEAD:<main>`
 * whose failure was reported as "N unmerged commits on <branch>", so once git
 * started refusing to move a checked-out ref, every ad-hoc worktree silently
 * "preserved" itself with a message blaming the commits instead of the tooling.
 */
import { describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fastForwardMain, worktreeHoldingBranch } from './git-ff-main'
import { dirtyMain, git, makeFixture } from './git-ff-main-fixture'

describe('worktreeHoldingBranch', () => {
  test('finds the working tree that has main checked out', () => {
    const fx = makeFixture()
    expect(worktreeHoldingBranch(fx.wt, 'main')).toBe(git(['rev-parse', '--show-toplevel'], fx.base).stdout)
  })

  test('returns null for a branch no working tree holds', () => {
    const fx = makeFixture()
    expect(worktreeHoldingBranch(fx.wt, 'nope')).toBeNull()
  })
})

describe('fastForwardMain', () => {
  test('merges inside main’s own worktree and leaves it consistent', () => {
    const fx = makeFixture()
    const res = fastForwardMain(fx.wt, 'main')

    expect(res.ok).toBe(true)
    expect(res.via).toBe('merge')
    expect(fx.mainRef()).toBe(fx.wtHead)
    expect(fx.baseStatus()).toBe('')
  })

  test('reports git’s verbatim reason on a real collision, and changes nothing', () => {
    const fx = makeFixture()
    const before = fx.mainRef()
    dirtyMain(fx, true)

    const res = fastForwardMain(fx.wt, 'main')

    expect(res.ok).toBe(false)
    // The old code threw this away and blamed the commits instead.
    expect(res.message).toContain('f.txt')
    expect(fx.mainRef()).toBe(before)
  })

  test('never claims success by moving the ref out from under a checkout', () => {
    const fx = makeFixture()
    fastForwardMain(fx.wt, 'main')
    // A `git update-ref` shortcut would pass the ref assertion above while
    // leaving main's index stale -- this is the assertion that rules it out.
    expect(fx.baseStatus()).toBe('')
  })

  test('falls back to fetch when main is checked out NOWHERE', () => {
    // Bare repo / CI: the old no-checkout fetch is still correct AND still
    // permitted there, so it stays as the fallback rather than being deleted.
    const dir = mkdtempSync(join(tmpdir(), 'wt-ffbare-'))
    const src = makeFixture()
    const bare = join(dir, 'bare.git')
    git(['clone', '-q', '--bare', src.base, bare], dir)
    const wtx = join(dir, 'wtx')
    git(['worktree', 'add', '-q', '-b', 'worktree-x', wtx, 'main'], bare)
    git(['config', 'user.email', 'test@example.com'], wtx)
    git(['config', 'user.name', 'Test'], wtx)
    Bun.spawnSync(['bash', '-c', 'echo three >> f.txt'], { cwd: wtx })
    git(['commit', '-qam', 'three'], wtx)

    expect(worktreeHoldingBranch(wtx, 'main')).toBeNull()

    const res = fastForwardMain(wtx, 'main')
    expect(res.ok).toBe(true)
    expect(res.via).toBe('fetch')
    expect(git(['rev-parse', 'main'], bare).stdout).toBe(git(['rev-parse', 'HEAD'], wtx).stdout)
  })

  test('is idempotent -- a second call is Already up to date, not a failure', () => {
    const fx = makeFixture()
    expect(fastForwardMain(fx.wt, 'main').ok).toBe(true)
    expect(fastForwardMain(fx.wt, 'main').ok).toBe(true)
  })
})
