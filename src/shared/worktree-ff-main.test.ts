/**
 * Merge-back must actually fast-forward main.
 *
 * The regression: worktree-finish.sh ended with `git fetch . HEAD:main`, and
 * git 2.54 refuses to move a ref checked out in ANY working tree --
 *   fatal: refusing to fetch into branch 'refs/heads/main' checked out at '<root>'
 * -- so every worktree session rebased cleanly and then died on its last step.
 * worktree-remove.sh ran the SAME call with `2>/dev/null` and reported the
 * refusal as "N unmerged commits that cannot be fast-forwarded", so perfectly
 * mergeable worktrees looked unmergeable and refused to be removed.
 *
 * Both copies of both scripts are exercised: the `scripts/` dev copy AND the
 * embedded copy that actually ships, resolved through the real resolveScript().
 * Fixing only one of them is the failure mode this file exists to catch.
 */
import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { dirtyMain, git, makeFixture } from './git-ff-main-fixture'
import { resolveScript } from './resolve-script'

const REPO_ROOT = join(import.meta.dir, '..', '..')

/**
 * Hang detector for a real `git` subprocess, NOT a perf budget.
 *
 * Every test below builds a scratch repo and shells out to real `git` (init,
 * worktree add, merge, fast-forward). The number only ever answered "did it
 * finish"; it never measured our code's speed. Under `bun test --parallel` on a
 * loaded box -- a worker per core, sometimes alongside another agent's suite --
 * these overshot bun's 5s default by under 200ms and turned the whole suite red
 * for scheduler weather. 30s is deliberately generous: a raise to just above the
 * observed number re-arms the same flake at the next busy moment.
 */
const GIT_HANG_TIMEOUT_MS = 30_000

function devCopy(name: string): string {
  return join(REPO_ROOT, 'scripts', name)
}

function shippedCopy(name: string): string {
  const p = resolveScript(name)
  if (!p) throw new Error(`no embedded ${name}`)
  return p
}

const COPIES = [
  ['scripts/ dev copy', devCopy],
  ['embedded shipped copy', shippedCopy],
] as const

function runFinish(script: string, cwd: string) {
  const res = Bun.spawnSync(['bash', script], { cwd })
  const dec = new TextDecoder()
  return { code: res.exitCode, out: `${dec.decode(res.stdout)}${dec.decode(res.stderr)}` }
}

function runRemove(script: string, wtPath: string) {
  const res = Bun.spawnSync(['bash', script], {
    stdin: Buffer.from(JSON.stringify({ name: 'feat', path: wtPath })),
  })
  const dec = new TextDecoder()
  return { code: res.exitCode, out: `${dec.decode(res.stdout)}${dec.decode(res.stderr)}` }
}

describe.each(COPIES)('worktree-finish.sh (%s)', (_label, resolve) => {
  const script = () => resolve('worktree-finish.sh')

  test(
    'fast-forwards main and leaves its checkout CONSISTENT',
    () => {
      const fx = makeFixture()
      const { code, out } = runFinish(script(), fx.wt)

      // The regression signature, asserted by name so a failure reads as itself.
      expect(out).not.toContain('refusing to fetch')
      expect(out).not.toContain('Manual merge needed')
      expect(code).toBe(0)
      expect(fx.mainRef()).toBe(fx.wtHead)

      // The whole point of git's guard: main's index and working tree must agree
      // with the ref afterwards. A stale checkout shows the merged files as
      // uncommitted REVERSALS, which is worse than the failure it replaced.
      expect(fx.baseStatus()).toBe('')
      expect(readFileSync(join(fx.base, 'f.txt'), 'utf8')).toBe('one\ntwo\n')
    },
    GIT_HANG_TIMEOUT_MS,
  )

  test(
    'refuses LOUDLY when main has local edits the merge would overwrite',
    () => {
      const fx = makeFixture()
      const before = fx.mainRef()
      dirtyMain(fx, true)

      const { code, out } = runFinish(script(), fx.wt)

      expect(code).toBe(1)
      // git's own reason must survive to the user, naming the blocking file.
      expect(out).toContain('f.txt')
      expect(fx.mainRef()).toBe(before)
      expect(readFileSync(join(fx.base, 'f.txt'), 'utf8')).toBe('locally edited\n')
    },
    GIT_HANG_TIMEOUT_MS,
  )

  test(
    'merges anyway when main is dirty on a file the merge does not touch',
    () => {
      // With a dozen live agents the root tree is almost always dirty on
      // something. Blocking on ANY dirt would make merge-back unusable, so only a
      // real collision may stop it.
      const fx = makeFixture()
      dirtyMain(fx, false)

      const { code } = runFinish(script(), fx.wt)

      expect(code).toBe(0)
      expect(fx.mainRef()).toBe(fx.wtHead)
      expect(readFileSync(join(fx.base, 'other.txt'), 'utf8')).toBe('locally edited\n')
    },
    GIT_HANG_TIMEOUT_MS,
  )

  test(
    'is a no-op when the branch is already merged',
    () => {
      const fx = makeFixture()
      expect(runFinish(script(), fx.wt).code).toBe(0)
      const { code, out } = runFinish(script(), fx.wt)
      expect(code).toBe(0)
      expect(out).toContain('Nothing to merge')
    },
    GIT_HANG_TIMEOUT_MS,
  )
})

describe.each(COPIES)('worktree-remove.sh (%s)', (_label, resolve) => {
  const script = () => resolve('worktree-remove.sh')

  test(
    'does not report a MERGEABLE worktree as unmergeable',
    () => {
      const fx = makeFixture()
      const { code, out } = runRemove(script(), fx.wt)

      // This was the lie: a clean, trivially-mergeable branch reported as
      // "N unmerged commits that cannot be fast-forwarded", refusing removal.
      expect(out).not.toContain('unmerged commits')
      expect(out).toContain('Auto-merged')
      expect(code).toBe(0)
      expect(fx.mainRef()).toBe(fx.wtHead)
    },
    GIT_HANG_TIMEOUT_MS,
  )

  test(
    'blocks on a real collision AND prints git’s reason instead of swallowing it',
    () => {
      const fx = makeFixture()
      dirtyMain(fx, true)

      const { code, out } = runRemove(script(), fx.wt)

      expect(code).toBe(1)
      expect(out).toContain('BLOCKED')
      // The `2>/dev/null` that made every failure look identical is gone.
      expect(out).toContain('f.txt')
    },
    GIT_HANG_TIMEOUT_MS,
  )
})

describe('the four shell copies do not drift', () => {
  function ffMainBlock(path: string): string {
    const body = readFileSync(path, 'utf8')
    const start = body.indexOf('ff_main() {')
    expect(start).toBeGreaterThan(-1)
    return body.slice(start, body.indexOf('\n}\n', start))
  }

  test('ff_main is byte-identical in dev and shipped copies of both scripts', () => {
    const blocks = [
      ffMainBlock(devCopy('worktree-finish.sh')),
      ffMainBlock(devCopy('worktree-remove.sh')),
      ffMainBlock(shippedCopy('worktree-finish.sh')),
      ffMainBlock(shippedCopy('worktree-remove.sh')),
    ]
    for (const b of blocks) expect(b).toBe(blocks[0])
  })

  test('no copy still ends merge-back on a bare fetch into main', () => {
    for (const name of ['worktree-finish.sh', 'worktree-remove.sh']) {
      for (const resolve of [devCopy, shippedCopy]) {
        const body = readFileSync(resolve(name), 'utf8')
        // The fetch survives ONLY inside ff_main, as the no-checkout fallback.
        const outsideHelper = body.slice(0, body.indexOf('ff_main() {'))
        expect(outsideHelper).not.toContain('fetch . "HEAD:')
      }
    }
  })
})

describe('the fixture proves the bug is real', () => {
  test(
    'git still refuses a direct fetch into main from the worktree',
    () => {
      const fx = makeFixture()
      const res = git(['fetch', '.', 'HEAD:main'], fx.wt)
      // If this ever starts passing, git relaxed the guard and the fallback path
      // could be widened again -- but the merge path stays correct either way.
      expect(res.code).not.toBe(0)
      expect(res.output).toContain('refusing to fetch')
    },
    GIT_HANG_TIMEOUT_MS,
  )
})
