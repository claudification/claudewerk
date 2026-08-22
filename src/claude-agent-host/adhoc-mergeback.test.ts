/**
 * THE FORK, pinned against a real repo.
 *
 * Four cards in one epic run reached `main` as bare fast-forwards with no
 * werk-master in the path -- the last of them EIGHT SECONDS after its
 * werk-verifier was dispatched, and that seat then removed its own worktree and
 * deleted its own local branch, so the engine's `rev-list --count main..<branch>`
 * scan had nothing left to report. Both halves are asserted here, and so is the
 * half that must NOT change: an ad-hoc seat on a throwaway branch still
 * fast-forwards exactly as it always did.
 *
 * Real git, not a stub: what is being defended is which refs moved.
 */
import { describe, expect, test } from 'bun:test'
import { existsSync } from 'node:fs'
import { git, makeFixture } from '../shared/git-ff-main-fixture'
import { WORKTREE_MERGEBACK_ENV } from '../shared/worktree-mergeback'
import { adHocMergeBack, type MergeBackDeps } from './adhoc-mergeback'

/** Collects what a human would have read on the conversation's diag stream. */
function recorder(env: Record<string, string | undefined>): MergeBackDeps & { lines: string[] } {
  const lines: string[] = []
  return { lines, env, diag: (_scope, message) => lines.push(message), debug: () => {} }
}

const EPIC_SEAT = { [WORKTREE_MERGEBACK_ENV]: '0' }

function input(fx: ReturnType<typeof makeFixture>) {
  return { projectRoot: fx.base, worktreePath: fx.wt, worktreeName: 'feat', branch: 'worktree-feat' }
}

describe('an epic-dispatched seat cannot move main', () => {
  test('exits one commit ahead and main has NOT moved', () => {
    const fx = makeFixture('wt-mb-epic-')
    const before = fx.mainRef()

    const out = adHocMergeBack(input(fx), recorder(EPIC_SEAT))

    expect(out).toEqual({ kind: 'held', ahead: 1 })
    expect(fx.mainRef()).toBe(before)
    expect(fx.mainRef()).not.toBe(fx.wtHead)
  })

  test('leaves BOTH the branch and the worktree standing, so the unmerged scan can see them', () => {
    // The fourth occurrence was invisible precisely because the seat cleaned up
    // after itself: no local branch, no worktree, nothing for the engine to count.
    const fx = makeFixture('wt-mb-epic-')

    adHocMergeBack(input(fx), recorder(EPIC_SEAT))

    expect(existsSync(fx.wt)).toBe(true)
    expect(git(['rev-parse', '--verify', 'worktree-feat'], fx.base).code).toBe(0)
    expect(git(['rev-list', '--count', 'main..worktree-feat'], fx.base).stdout).toBe('1')
  })

  test('says so LOUDLY -- a held branch and a stranded one must never read the same', () => {
    const fx = makeFixture('wt-mb-epic-')
    const rec = recorder(EPIC_SEAT)

    adHocMergeBack(input(fx), rec)

    const said = rec.lines.join('\n')
    expect(said).toContain('worktree-feat')
    expect(said).toContain('left unmerged')
    expect(said).toContain('werk-master')
    // Never the ad-hoc success line.
    expect(said).not.toContain('Merged 1 commits')
  })

  test('holds even with nothing to merge -- it still may not delete the worktree', () => {
    const fx = makeFixture('wt-mb-epic-')
    git(['merge', '--ff-only', fx.wtHead], fx.base)

    const out = adHocMergeBack(input(fx), recorder(EPIC_SEAT))

    expect(out).toEqual({ kind: 'held', ahead: 0 })
    expect(existsSync(fx.wt)).toBe(true)
  })
})

describe('an ad-hoc seat still fast-forwards exactly as it does today', () => {
  test('no flag at all: main advances and the worktree is cleaned up', () => {
    const fx = makeFixture('wt-mb-adhoc-')

    const out = adHocMergeBack(input(fx), recorder({}))

    expect(out).toEqual({ kind: 'merged', ahead: 1, removed: true })
    expect(fx.mainRef()).toBe(fx.wtHead)
    expect(existsSync(fx.wt)).toBe(false)
    expect(git(['rev-parse', '--verify', 'worktree-feat'], fx.base).code).not.toBe(0)
  })

  test('the flag set to something other than the off value does not disarm the defence', () => {
    const fx = makeFixture('wt-mb-adhoc-')

    adHocMergeBack(input(fx), recorder({ [WORKTREE_MERGEBACK_ENV]: '1' }))

    expect(fx.mainRef()).toBe(fx.wtHead)
  })

  test('nothing ahead: main is untouched, the worktree is still cleaned up', () => {
    const fx = makeFixture('wt-mb-adhoc-')
    git(['merge', '--ff-only', fx.wtHead], fx.base)
    const before = fx.mainRef()

    const out = adHocMergeBack(input(fx), recorder({}))

    expect(out).toEqual({ kind: 'nothing-to-merge', removed: true })
    expect(fx.mainRef()).toBe(before)
    expect(existsSync(fx.wt)).toBe(false)
  })
})

describe('the pre-existing behaviour the extraction must not have changed', () => {
  test('a worktree CC already removed reports absent and touches nothing', () => {
    const fx = makeFixture('wt-mb-gone-')
    const rec = recorder({})

    const out = adHocMergeBack({ ...input(fx), worktreePath: `${fx.wt}-nope` }, rec)

    expect(out).toEqual({ kind: 'absent' })
    expect(rec.lines.join('\n')).toContain('already cleaned up')
  })

  test('a refused fast-forward keeps the worktree and quotes git verbatim', () => {
    const fx = makeFixture('wt-mb-refuse-')
    // Dirty the very file the merge would overwrite: git aborts, nothing moves.
    Bun.write(`${fx.base}/f.txt`, 'locally edited\n')
    const before = fx.mainRef()
    const rec = recorder({})

    const out = adHocMergeBack(input(fx), rec)

    expect(out.kind).toBe('refused')
    expect(fx.mainRef()).toBe(before)
    expect(existsSync(fx.wt)).toBe(true)
    expect(rec.lines.join('\n')).toContain('NO CODE LOST')
  })
})
