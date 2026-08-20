/**
 * Regression test for the merge-blind commit ledger (epic-the-wall-ii, gen 25).
 *
 * The ledger was a `post-commit` hook only, and **git does not fire post-commit
 * for a merge it completes on its own**. So every integration merge that applied
 * cleanly was invisible to `commits.db` -- the exact commit you most want
 * attributed later, because it is the one that changes `main`.
 *
 * The firing matrix (asserted in install-git-hooks.test.ts, and the reason this
 * needs BOTH hooks):
 *
 *   clean `git merge --no-ff`             -> post-merge,  NOT post-commit
 *   fast-forward `git merge` / `git pull` -> post-merge,  NOT post-commit
 *   conflict + `git merge --continue`     -> post-commit, NOT post-merge
 *   conflict + `git commit`               -> post-commit, NOT post-merge
 *   an ordinary commit                    -> post-commit
 *
 * A FAST-FORWARD is the one case post-merge must NOT record: git moved HEAD onto
 * commits authored somewhere else, and calling those "a commit made here" would
 * attribute another machine's work to this conversation. Only a real merge
 * commit -- 2+ parents -- was made by the merge that just ran.
 *
 * The broker is a real local HTTP server here, not a stub script: what is under
 * test is that the hook's detached, time-capped `curl` actually reaches
 * `/api/commits` with the merge hash, which a shell stub could not prove.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALLER = new URL('./install-git-hooks.sh', import.meta.url).pathname

/** The hook backgrounds its curl and closes every fd, so a POST lands after the
 *  git command has already returned. Poll rather than sleep a fixed amount. */
const DELIVERY_TIMEOUT_MS = 5_000
const QUIET_MS = 700

interface Ledger {
  url: string
  posts: Array<Record<string, unknown>>
  stop: () => void
}

function startLedger(): Ledger {
  const posts: Array<Record<string, unknown>> = []
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname !== '/api/commits') return new Response('no', { status: 404 })
      posts.push((await req.json()) as Record<string, unknown>)
      return new Response('{"ok":true}', { headers: { 'content-type': 'application/json' } })
    },
  })
  return { url: `http://127.0.0.1:${server.port}`, posts, stop: () => server.stop(true) }
}

/** Resolve as soon as `count` posts have arrived; throw with what did arrive. */
async function waitForPosts(ledger: Ledger, count: number): Promise<void> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS
  while (ledger.posts.length < count) {
    if (Date.now() > deadline) {
      throw new Error(`expected ${count} ledger post(s), got ${ledger.posts.length}: ${JSON.stringify(ledger.posts)}`)
    }
    await Bun.sleep(25)
  }
}

/** Give a hook that should post NOTHING enough time to prove it. */
const settle = () => Bun.sleep(QUIET_MS)

const repos: string[] = []
const ledgers: Ledger[] = []
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const l of ledgers.splice(0)) l.stop()
})

interface Repo {
  dir: string
  env: Record<string, string>
}

function makeRepo(ledger: Ledger): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'ledgerhook-'))
  repos.push(dir)
  const stubDir = join(dir, 'stub')

  sh(dir, 'mkdir -p stub && git init -q -b main .')
  // Jonas's machine sets a GLOBAL core.hooksPath; without a local override git
  // would never look in this repo's .git/hooks and every assertion here would
  // be vacuously green.
  sh(dir, `git config user.email t@t.t && git config user.name T && git config core.hooksPath "${dir}/.git/hooks"`)
  // The fallow merge audit shares these hooks. It is not what is under test and
  // a real audit costs seconds per merge, so it gets a stub that always passes.
  writeFileSync(
    join(stubDir, 'fallow'),
    ['#!/bin/bash', 'echo \'{"verdict":"pass","changed_files_count":1,"attribution":{}}\'', 'exit 0', ''].join('\n'),
  )
  sh(dir, 'chmod +x stub/fallow')

  writeFileSync(join(dir, 'a.txt'), 'base\n')
  sh(dir, 'git add -A && git commit -qm base')

  return {
    dir,
    env: {
      PATH: `${stubDir}:${process.env.PATH}`,
      GIT_EDITOR: 'true',
      RCLAUDE_BROKER: ledger.url,
      RCLAUDE_SECRET: 'test-secret',
      RCLAUDE_CONVERSATION_ID: 'conv-under-test',
    },
  }
}

function sh(dir: string, command: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bash', '-c', command], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

function install(repo: Repo, args = '') {
  return sh(repo.dir, `bash "${INSTALLER}" ${args} .`, repo.env)
}

function head(repo: Repo): string {
  return sh(repo.dir, 'git rev-parse HEAD').stdout.trim()
}

/** Two branches touching different files, so the merge is clean. */
function setUpCleanMerge(repo: Repo) {
  sh(repo.dir, 'git checkout -q -b side && echo side > b.txt && git add -A && git commit -qm side')
  sh(repo.dir, 'git checkout -q main && echo main >> a.txt && git add -A && git commit -qm main1')
}

/** Two branches touching the SAME line, so the merge conflicts. */
function setUpConflict(repo: Repo) {
  sh(repo.dir, 'git checkout -q -b side && echo left > c.txt && git add -A && git commit -qm side')
  sh(repo.dir, 'git checkout -q main && echo right > c.txt && git add -A && git commit -qm main1')
  sh(repo.dir, 'git merge --no-ff side -m conflicted', repo.env)
  sh(repo.dir, 'echo resolved > c.txt && git add c.txt')
}

function newLedger(): Ledger {
  const ledger = startLedger()
  ledgers.push(ledger)
  return ledger
}

describe('commit ledger on merges', () => {
  // THE BUG. Before the post-merge wiring this returned zero posts, which is
  // how ~25 integration merges onto `main` went unattributed during this epic.
  test('a clean `git merge --no-ff` is recorded', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)
    expect(merged.code).toBe(0)

    await waitForPosts(ledger, 1)
    const post = ledger.posts[0]
    expect(post.hash).toBe(head(repo))
    expect(post.subject).toBe('merge side')
    // 2+ parents is what makes the broker classify this as kind=merge.
    expect(String(post.parents).trim().split(/\s+/)).toHaveLength(2)
    expect(post.conversationId).toBe('conv-under-test')
  })

  // A fast-forward makes NO commit. post-merge fires anyway, with HEAD already
  // at a tip authored elsewhere -- recording it would attribute someone else's
  // commits to whoever ran `git pull`.
  test('a fast-forward merge is NOT recorded', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    sh(repo.dir, 'git checkout -q -b side && echo side > b.txt && git add -A && git commit -qm side')
    sh(repo.dir, 'git checkout -q main')

    const merged = sh(repo.dir, 'git merge side', repo.env)
    expect(merged.code).toBe(0)
    expect(sh(repo.dir, 'git log -1 --format=%P').stdout.trim()).not.toContain(' ')

    await settle()
    expect(ledger.posts).toEqual([])
  })

  // post-commit and post-merge are disjoint per the firing matrix, so this is
  // the assertion that keeps them that way if either hook's guard drifts.
  test('a conflicted merge finished by hand is recorded exactly once', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    setUpConflict(repo)

    const done = sh(repo.dir, 'git merge --continue', repo.env)
    expect(done.code).toBe(0)

    await waitForPosts(ledger, 1)
    await settle()
    expect(ledger.posts).toHaveLength(1)
    expect(ledger.posts[0].hash).toBe(head(repo))
  })

  test('an ordinary commit is still recorded', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)

    sh(repo.dir, 'echo more >> a.txt && git add -A && git commit -qm ordinary', repo.env)

    await waitForPosts(ledger, 1)
    expect(ledger.posts[0].subject).toBe('ordinary')
    expect(ledger.posts[0].hash).toBe(head(repo))
  })

  test('RCLAUDE_COMMIT_LEDGER=0 skips a merge too', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    setUpCleanMerge(repo)

    sh(repo.dir, 'git merge --no-ff side -m "merge side"', { ...repo.env, RCLAUDE_COMMIT_LEDGER: '0' })

    await settle()
    expect(ledger.posts).toEqual([])
  })

  test('no RCLAUDE_BROKER means a merge posts nowhere and still succeeds', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    setUpCleanMerge(repo)

    const env = { ...repo.env, RCLAUDE_BROKER: '' }
    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', env)

    expect(merged.code).toBe(0)
    await settle()
    expect(ledger.posts).toEqual([])
  })

  // Both blocks live in post-merge. Neither may swallow the other.
  test('the merge audit and the ledger both run on the same merge', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(merged.stderr).toContain('fallow-merge-warn')
    await waitForPosts(ledger, 1)
    expect(ledger.posts[0].hash).toBe(head(repo))
  })

  test('a pre-existing post-merge hook still runs alongside the ledger', async () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    writeFileSync(join(repo.dir, '.git/hooks/post-merge'), '#!/bin/sh\necho FOREIGN-MERGE >&2\n')
    sh(repo.dir, 'chmod +x .git/hooks/post-merge')
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(merged.stderr).toContain('FOREIGN-MERGE')
    await waitForPosts(ledger, 1)
  })

  test('--status reports the ledger on both hooks', () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)

    const status = install(repo, '--status').stdout

    expect(status).toContain('post-commit (commit ledger)')
    expect(status).toContain('+ commit ledger on merge commits')
  })

  test('uninstall takes the ledger off post-merge as well', () => {
    const ledger = newLedger()
    const repo = makeRepo(ledger)
    install(repo)

    expect(install(repo, '--uninstall').code).toBe(0)

    expect(sh(repo.dir, 'ls .git/hooks/post-merge').code).not.toBe(0)
  })
})
