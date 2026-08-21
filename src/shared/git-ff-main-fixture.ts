/**
 * Test support for the worktree merge-back fix: builds a REAL throwaway repo
 * shaped like this project -- `main` checked out at a root, a `worktree-*`
 * branch checked out beside it and one commit ahead.
 *
 * Deliberately not a stubbed git. The bug being guarded is git's own refusal to
 * move a checked-out ref, so a fake git would assert nothing. These repos are
 * two commits deep and cost single-digit milliseconds.
 *
 * Shared by git-ff-main.test.ts and worktree-ff-main.test.ts.
 */
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface GitRun {
  code: number
  stdout: string
  stderr: string
  /** stdout + stderr, for asserting on a message wherever git chose to put it. */
  output: string
}

/** `node:child_process` for the same reason as git-ff-main.ts: web typechecks this dir. */
export function git(args: string[], cwd: string): GitRun {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8' })
  const stdout = (res.stdout ?? '').trim()
  const stderr = (res.stderr ?? '').trim()
  return { code: res.status ?? 1, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n') }
}

export interface Fixture {
  /** Working tree holding `main`. Stands in for the repo root. */
  base: string
  /** Working tree holding `worktree-feat`, one commit ahead of main. */
  wt: string
  /** The commit `wt` is at, i.e. what main must fast-forward to. */
  wtHead: string
  mainRef(): string
  baseStatus(): string
}

/** `main` at `base`, `worktree-feat` at `wt` one commit ahead, touching f.txt. */
export function makeFixture(prefix = 'wt-ffmain-'): Fixture {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const base = join(dir, 'base')
  const wt = join(dir, 'wt')

  git(['init', '-q', '-b', 'main', 'base'], dir)
  git(['config', 'user.email', 'test@example.com'], base)
  git(['config', 'user.name', 'Test'], base)
  writeFileSync(join(base, 'f.txt'), 'one\n')
  // A second file so a test can dirty main WITHOUT colliding with the merge.
  writeFileSync(join(base, 'other.txt'), 'keep\n')
  git(['add', '.'], base)
  git(['commit', '-qm', 'one'], base)

  git(['worktree', 'add', '-q', '-b', 'worktree-feat', wt], base)
  writeFileSync(join(wt, 'f.txt'), 'one\ntwo\n')
  git(['commit', '-qam', 'two'], wt)

  return {
    base,
    wt,
    wtHead: git(['rev-parse', 'HEAD'], wt).stdout,
    mainRef: () => git(['rev-parse', 'main'], base).stdout,
    baseStatus: () => git(['status', '--porcelain'], base).stdout,
  }
}

/** Dirty a file in main's checkout. `collides` picks the file the merge touches. */
export function dirtyMain(fx: Fixture, collides: boolean): void {
  const file = collides ? 'f.txt' : 'other.txt'
  writeFileSync(join(fx.base, file), 'locally edited\n')
}
