/**
 * Regression test for the merge-blind fallow gate (epic-the-wall-ii, gen 22-23).
 *
 * `.claude/hooks/fallow-gate.sh` matches `git commit` / `git push` and nothing
 * else, so 25 merges onto `main` landed unaudited and a summed CRAP regression
 * in `SheafPane` reached `main` through one of them. The fix is a pair of git
 * post-hooks that audit the POST-merge tree and only ever WARN.
 *
 * The wiring is the part that is easy to get wrong, and it is not guessable --
 * these are the empirically verified firing rules, and every one of them is
 * asserted below:
 *
 *   clean `git merge --no-ff`             -> post-merge,  NOT post-commit
 *   fast-forward `git merge` / `git pull` -> post-merge,  NOT post-commit
 *   conflict + `git merge --continue`     -> post-commit, NOT post-merge
 *   conflict + `git commit`               -> post-commit, NOT post-merge
 *   an ordinary commit                    -> neither (the PreToolUse gate owns it)
 *
 * fallow itself is stubbed: what is under test is which hook fires, with which
 * base, and that a `fail` verdict never blocks. The real binary is exercised in
 * the card's manual proof, not here -- a real audit costs ~2s per merge.
 */

import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const INSTALLER = new URL('./install-git-hooks.sh', import.meta.url).pathname

const FAIL_VERDICT = JSON.stringify({
  verdict: 'fail',
  changed_files_count: 3,
  attribution: { complexity_introduced: 1, dead_code_introduced: 0, duplication_introduced: 0 },
  complexity: {
    findings: [
      {
        path: 'web/src/components/SheafPane.tsx',
        name: 'SheafPane',
        line: 42,
        crap: 342,
        cyclomatic: 18,
        exceeded: 'cognitive_crap',
        introduced: true,
      },
    ],
  },
})
const PASS_VERDICT = JSON.stringify({ verdict: 'pass', changed_files_count: 3, attribution: {} })

const repos: string[] = []
afterEach(() => {
  for (const dir of repos.splice(0)) rmSync(dir, { recursive: true, force: true })
})

type Repo = { dir: string; env: Record<string, string>; calls: () => string[] }

function sh(dir: string, command: string, env: Record<string, string> = {}) {
  const proc = Bun.spawnSync(['bash', '-c', command], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    code: proc.exitCode,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString(),
  }
}

/** A git repo with a stubbed `fallow` first on PATH, logging every invocation. */
function makeRepo(verdict = FAIL_VERDICT): Repo {
  const dir = mkdtempSync(join(tmpdir(), 'hookwiring-'))
  repos.push(dir)
  const log = join(dir, 'fallow-calls.log')
  const stubDir = join(dir, 'stub')

  sh(dir, 'mkdir -p stub && git init -q -b main .')
  // Jonas's machine sets a GLOBAL core.hooksPath; without a local override git
  // would never look in this repo's .git/hooks and every assertion here would
  // be vacuously green.
  sh(dir, `git config user.email t@t.t && git config user.name T && git config core.hooksPath "${dir}/.git/hooks"`)
  writeFileSync(join(stubDir, 'verdict.json'), verdict)
  writeFileSync(
    join(stubDir, 'fallow'),
    ['#!/bin/bash', `echo "$*" >> "${log}"`, `cat "${stubDir}/verdict.json"`, 'exit 1', ''].join('\n'),
  )
  sh(dir, 'chmod +x stub/fallow')

  writeFileSync(join(dir, 'a.txt'), 'base\n')
  sh(dir, 'git add -A && git commit -qm base')

  return {
    dir,
    env: { PATH: `${stubDir}:${process.env.PATH}`, GIT_EDITOR: 'true' },
    calls: () => {
      try {
        return readFileSync(log, 'utf8').split('\n').filter(Boolean)
      } catch {
        return []
      }
    },
  }
}

function install(repo: Repo, args = '') {
  return sh(repo.dir, `bash "${INSTALLER}" ${args} .`, repo.env)
}

/** Two branches that touch different files, so the merge is clean. */
function setUpCleanMerge(repo: Repo) {
  sh(repo.dir, 'git checkout -q -b side && echo side > b.txt && git add -A && git commit -qm side')
  sh(repo.dir, 'git checkout -q main && echo main >> a.txt && git add -A && git commit -qm main1')
}

/** Two branches that touch the SAME line, so the merge conflicts. */
function setUpConflict(repo: Repo) {
  sh(repo.dir, 'git checkout -q -b side && echo left > c.txt && git add -A && git commit -qm side')
  sh(repo.dir, 'git checkout -q main && echo right > c.txt && git add -A && git commit -qm main1')
  sh(repo.dir, 'git merge --no-ff side -m "conflicted"', repo.env)
  sh(repo.dir, 'echo resolved > c.txt && git add c.txt')
}

describe('install-git-hooks', () => {
  test('reports nothing installed before it runs', () => {
    const repo = makeRepo()
    const out = install(repo, '--status').stdout
    expect(out).toContain('not installed')
    expect(out).toContain('post-merge')
  })

  test('installs post-commit, post-merge and the audit script', () => {
    const repo = makeRepo()
    expect(install(repo).code).toBe(0)
    const status = install(repo, '--status').stdout
    expect(status).toContain('installed:')
    expect(status).toContain('post-merge (fallow merge audit)')
    expect(status).toContain('fallow-merge-warn.sh (matches source)')
    // The ledger must survive the second hook moving in next to it.
    expect(readFileSync(join(repo.dir, '.git/hooks/post-commit'), 'utf8')).toContain('claudewerk_commit_ledger')
  })

  test('a clean merge fires the audit against the first parent, and does not block', () => {
    const repo = makeRepo()
    install(repo)
    setUpCleanMerge(repo)
    const firstParent = sh(repo.dir, 'git rev-parse HEAD').stdout.trim()

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(merged.code).toBe(0)
    expect(merged.stderr).toContain("fallow-merge-warn: verdict 'fail'")
    expect(merged.stderr).toContain('SheafPane')
    expect(merged.stderr).toContain('NOTHING IS BLOCKED')
    expect(repo.calls()).toHaveLength(1)
    expect(repo.calls()[0]).toContain(`--changed-since ${firstParent}`)
  })

  test('a conflicted merge finished with `git commit` still fires the audit', () => {
    const repo = makeRepo()
    install(repo)
    setUpConflict(repo)

    const done = sh(repo.dir, 'git commit --no-edit', repo.env)

    expect(done.code).toBe(0)
    expect(done.stderr).toContain("fallow-merge-warn: verdict 'fail'")
    expect(repo.calls()).toHaveLength(1)
  })

  test('a conflicted merge finished with `git merge --continue` still fires the audit', () => {
    const repo = makeRepo()
    install(repo)
    setUpConflict(repo)

    const done = sh(repo.dir, 'git merge --continue', repo.env)

    expect(done.code).toBe(0)
    expect(done.stderr).toContain("fallow-merge-warn: verdict 'fail'")
    expect(repo.calls()).toHaveLength(1)
  })

  test('a fast-forward merge audits against ORIG_HEAD', () => {
    const repo = makeRepo()
    install(repo)
    sh(repo.dir, 'git checkout -q -b side && echo side > b.txt && git add -A && git commit -qm side')
    sh(repo.dir, 'git checkout -q main')
    const before = sh(repo.dir, 'git rev-parse HEAD').stdout.trim()

    const merged = sh(repo.dir, 'git merge side', repo.env)

    expect(merged.code).toBe(0)
    expect(merged.stderr).toContain('fast-forward to')
    expect(repo.calls()[0]).toContain(`--changed-since ${before}`)
  })

  test('an ordinary commit is NOT audited -- the blocking PreToolUse gate owns it', () => {
    const repo = makeRepo()
    install(repo)

    const committed = sh(repo.dir, 'echo more >> a.txt && git add -A && git commit -qm ordinary', repo.env)

    expect(committed.code).toBe(0)
    expect(repo.calls()).toEqual([])
  })

  // The two tests below are the reason this is a PAIR of hooks. Delete either
  // one from the installer and exactly one of them goes red -- which is the
  // whole content of the bug this card exists for.
  test('post-commit alone would miss a clean merge', () => {
    const repo = makeRepo()
    install(repo)
    rmSync(join(repo.dir, '.git/hooks/post-merge'))
    setUpCleanMerge(repo)

    sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(repo.calls()).toEqual([])
  })

  test('post-merge alone would miss a conflict resolved by hand', () => {
    const repo = makeRepo()
    install(repo)
    rmSync(join(repo.dir, '.git/hooks/post-commit'))
    setUpConflict(repo)

    sh(repo.dir, 'git merge --continue', repo.env)

    expect(repo.calls()).toEqual([])
  })

  test('a pass verdict prints one line and no banner', () => {
    const repo = makeRepo(PASS_VERDICT)
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(merged.stderr).toContain('audited 3 changed files')
    expect(merged.stderr).toContain('pass')
    expect(merged.stderr).not.toContain('NOTHING IS BLOCKED')
  })

  test('RCLAUDE_FALLOW_MERGE_WARN=0 skips the audit entirely', () => {
    const repo = makeRepo()
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', {
      ...repo.env,
      RCLAUDE_FALLOW_MERGE_WARN: '0',
    })

    expect(merged.code).toBe(0)
    expect(repo.calls()).toEqual([])
    expect(merged.stderr).not.toContain('fallow-merge-warn')
  })

  test('the audit script exits 0 on a fail verdict when run directly', () => {
    const repo = makeRepo()
    install(repo)
    setUpCleanMerge(repo)
    sh(repo.dir, 'git merge --no-ff side -m "merge side"', { ...repo.env, RCLAUDE_FALLOW_MERGE_WARN: '0' })

    const direct = sh(repo.dir, '.git/hooks/fallow-merge-warn.sh --event merge', repo.env)

    expect(direct.code).toBe(0)
    expect(direct.stderr).toContain("verdict 'fail'")
  })

  test('a pre-existing post-merge hook is preserved and still runs first', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.dir, '.git/hooks/post-merge'), '#!/bin/sh\necho FOREIGN-MERGE >&2\n')
    sh(repo.dir, 'chmod +x .git/hooks/post-merge')
    install(repo)
    setUpCleanMerge(repo)

    const merged = sh(repo.dir, 'git merge --no-ff side -m "merge side"', repo.env)

    expect(merged.stderr).toContain('FOREIGN-MERGE')
    expect(merged.stderr).toContain('fallow-merge-warn')
  })

  test('a pre-existing post-commit hook is preserved and still runs first', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.dir, '.git/hooks/post-commit'), '#!/bin/sh\necho FOREIGN-COMMIT >&2\nexit 0\n')
    sh(repo.dir, 'chmod +x .git/hooks/post-commit')
    install(repo)

    const committed = sh(repo.dir, 'echo more >> a.txt && git add -A && git commit -qm ordinary', repo.env)

    expect(committed.stderr).toContain('FOREIGN-COMMIT')
  })

  test('re-installing does not mistake our own dispatcher for a foreign hook', () => {
    const repo = makeRepo()
    install(repo)
    const second = install(repo)

    expect(second.stdout).not.toContain('preserved')
    expect(second.stdout).not.toContain('recovered')
    expect(install(repo, '--status').stdout).not.toContain('chained')
  })

  // `.claude/hooks/fallow-gate.sh` is generated by `fallow setup-hooks`, which
  // overwrites it wholesale. Nothing that matters lives there any more, but the
  // header note describing the merge blind spot does -- so --status is the
  // marker that makes a regeneration noticeable.
  test('--status flags a fallow-gate.sh that lost its merge blind-spot note', () => {
    const repo = makeRepo()
    install(repo)
    sh(repo.dir, 'mkdir -p .claude/hooks')
    writeFileSync(join(repo.dir, '.claude/hooks/fallow-gate.sh'), '#!/usr/bin/env bash\n# Blocks git commit.\n')

    expect(install(repo, '--status').stdout).toContain('no longer documents its merge blind spot')
  })

  test('--status stays quiet when the gate still documents it', () => {
    const repo = makeRepo()
    install(repo)
    sh(repo.dir, 'mkdir -p .claude/hooks')
    writeFileSync(
      join(repo.dir, '.claude/hooks/fallow-gate.sh'),
      '#!/usr/bin/env bash\n# Does NOT see `git merge`; see docs/fallow-merge-audit.md.\n',
    )

    expect(install(repo, '--status').stdout).not.toContain('merge blind spot')
  })

  test('uninstall removes ours and puts the foreign hooks back', () => {
    const repo = makeRepo()
    writeFileSync(join(repo.dir, '.git/hooks/post-merge'), '#!/bin/sh\necho FOREIGN-MERGE >&2\n')
    sh(repo.dir, 'chmod +x .git/hooks/post-merge')
    install(repo)

    expect(install(repo, '--uninstall').code).toBe(0)

    const status = install(repo, '--status').stdout
    expect(status).toContain('not installed')
    expect(readFileSync(join(repo.dir, '.git/hooks/post-merge'), 'utf8')).toContain('FOREIGN-MERGE')
    expect(sh(repo.dir, 'ls .git/hooks/fallow-merge-warn.sh').code).not.toBe(0)
  })

  // `git rev-parse --git-path hooks` HONOURS core.hooksPath, so the installer
  // always writes where git looks. The hazard runs the other way: a global
  // core.hooksPath quietly makes this a machine-wide install.
  test('warns when core.hooksPath redirects the install out of the repo', () => {
    const repo = makeRepo()
    sh(repo.dir, `git config core.hooksPath "${repo.dir}/elsewhere"`)

    const out = install(repo)

    expect(`${out.stdout}${out.stderr}`).toContain('core.hooksPath redirected this install')
    expect(readFileSync(join(repo.dir, 'elsewhere/post-merge'), 'utf8')).toContain('fallow-merge-warn')
  })

  // macOS hands out temp dirs under /var, which git reports as /private/var.
  // Comparing the LOGICAL paths fired this warning on every install here.
  test('does not warn when the hooks dir is the default one behind a symlink', () => {
    const repo = makeRepo()

    const out = install(repo)

    expect(`${out.stdout}${out.stderr}`).not.toContain('WARNING')
  })
})
