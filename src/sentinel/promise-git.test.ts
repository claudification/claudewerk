/**
 * The git-backed `CommitResolver` -- against a REAL repo, deliberately.
 *
 * A mocked `git()` would test the branch table and leave the only thing that
 * matters unexercised: does this file's answer match what git actually says, at
 * the sizes a real board reaches. The bug that earned this test was invisible to
 * every unit-level check because it only appeared past the 200th DISTINCT sha in
 * one scan -- a threshold no hand-written fixture crosses and this repo's board
 * crossed on 2026-08-22 with 204.
 *
 * THE SCALE CASE IS THE POINT. `resolves every sha on a board larger than the
 * old cap` is not a perf test; it asserts that a resolver cannot answer
 * `could not verify` about a commit sitting on main. That verdict is one of the
 * two the ledger renders in red, so a false one accuses a delivered card, which
 * is the failure mode `promise-git.ts`'s own header calls the end of the feature.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGitResolver, resolvePromiseBase } from './promise-git'

let root: string

/** One `git -C root`, throwing on failure -- a broken fixture must not read as a
 *  passing assertion about the code under test. */
function git(...args: string[]): string {
  const proc = Bun.spawnSync(['git', '-C', root, ...args], { stdout: 'pipe', stderr: 'pipe' })
  if (proc.exitCode !== 0) throw new Error(`fixture git ${args.join(' ')}: ${new TextDecoder().decode(proc.stderr)}`)
  return new TextDecoder().decode(proc.stdout).trim()
}

/** An empty commit, and the sha it produced. */
function commit(message: string): string {
  git('commit', '--allow-empty', '-q', '-m', message)
  return git('rev-parse', 'HEAD')
}

/**
 * `n` empty commits on main in ONE process, newest first.
 *
 * `git commit` costs ~20ms of process startup, so the 250-commit history the
 * scale case needs takes five seconds to build one commit at a time -- longer
 * than the test itself is allowed. `fast-import` writes the whole chain in a
 * single spawn, which keeps the fixture off the critical path where it belongs.
 */
function commitChain(n: number): string[] {
  const stream: string[] = []
  for (let i = 0; i < n; i += 1) {
    stream.push('commit refs/heads/main', `mark :${i + 1}`, 'committer Test <test@example.com> 0 +0000')
    stream.push(`data ${`c${i}`.length}`, `c${i}`)
    if (i > 0) stream.push(`from :${i}`)
  }
  const proc = Bun.spawnSync(['git', '-C', root, 'fast-import', '--quiet'], {
    stdin: new TextEncoder().encode(`${stream.join('\n')}\n`),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (proc.exitCode !== 0) throw new Error(`fixture fast-import: ${new TextDecoder().decode(proc.stderr)}`)
  return git('rev-list', 'main').split('\n')
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'promise-git-'))
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@example.com')
  git('config', 'user.name', 'Test')
  git('config', 'commit.gpgsign', 'false')
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('resolvePromiseBase', () => {
  test('prefers local main', () => {
    commit('first')
    expect(resolvePromiseBase(root)).toBe('main')
  })

  test('null outside a work tree -- every verdict then reads as unverifiable', () => {
    expect(resolvePromiseBase(mkdtempSync(join(tmpdir(), 'not-a-repo-')))).toBeNull()
  })
})

describe('createGitResolver', () => {
  test('a commit on main exists and is on main', () => {
    const sha = commit('landed')
    expect(createGitResolver(root, 'main')(sha)).toEqual({ sha, exists: true, onMain: true })
  })

  test('a commit on an unmerged branch exists and is NOT on main', () => {
    commit('base')
    git('checkout', '-q', '-b', 'side')
    const sha = commit('still on a branch')
    git('checkout', '-q', 'main')
    expect(createGitResolver(root, 'main')(sha)).toEqual({ sha, exists: true, onMain: false })
  })

  test('a sha git has never heard of does not exist -- the one earned accusation', () => {
    commit('base')
    const sha = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeef'
    expect(createGitResolver(root, 'main')(sha)).toEqual({ sha, exists: false, onMain: false })
  })

  test('an ABBREVIATED sha resolves like the full one -- `closes:` is hand-written at 8 chars', () => {
    const full = commit('landed')
    const short = full.slice(0, 8)
    expect(createGitResolver(root, 'main')(short)).toEqual({ sha: short, exists: true, onMain: true })
  })

  test('a base of null answers nothing rather than guessing false', () => {
    const sha = commit('landed')
    expect(createGitResolver(root, null)(sha)).toEqual({ sha, exists: null, onMain: null })
  })

  test('a revision that is not sha-shaped never reaches git', () => {
    commit('base')
    const resolve = createGitResolver(root, 'main')
    expect(resolve('HEAD~1')).toEqual({ sha: 'HEAD~1', exists: null, onMain: null })
    expect(resolve('--upload-pack=touch /tmp/pwned')).toEqual({
      sha: '--upload-pack=touch /tmp/pwned',
      exists: null,
      onMain: null,
    })
  })

  /**
   * THE REGRESSION. `MAX_RESOLVED_SHAS = 200` silently turned every sha past the
   * 200th into `could not verify`, and this board hit 204. Four cards whose
   * commits are all ancestors of main rendered in the loud table.
   *
   * 250 rather than 201 so the assertion keeps meaning something if somebody
   * raises a cap instead of removing the cliff.
   */
  test('resolves EVERY sha on a board larger than the old 200-sha cap', () => {
    const shas = commitChain(250)
    expect(shas).toHaveLength(250)

    const resolve = createGitResolver(root, 'main')
    const answers = shas.map(resolve)

    expect(answers.filter(a => a.exists === null || a.onMain === null)).toEqual([])
    expect(answers.every(a => a.exists === true && a.onMain === true)).toBe(true)
  })

  test('memoises -- the same sha asked twice is the same answer object', () => {
    const sha = commit('landed')
    const resolve = createGitResolver(root, 'main')
    expect(resolve(sha)).toBe(resolve(sha))
  })
})
