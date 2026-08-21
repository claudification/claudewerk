/**
 * Test support for keeping the board out of worktrees.
 *
 * Builds a REAL throwaway repo shaped like this project: `main` at a root with
 * `.rclaude/project/` TRACKED, and a worktree under `.claude/worktrees/` beside
 * it. Deliberately not a stubbed git -- what is being guarded is git's own
 * sparse-checkout behaviour, so a fake git would assert nothing.
 *
 * The fixture pins GIT_CONFIG_GLOBAL and GIT_CONFIG_SYSTEM to /dev/null. This
 * machine's ~/.gitignore ignores `.rclaude/` globally, and without the pin
 * `git add` silently skips the board and every assertion below passes for the
 * wrong reason -- the fixture would prove nothing.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const HERMETIC_ENV = {
  ...process.env,
  GIT_CONFIG_GLOBAL: '/dev/null',
  GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com',
}

export interface GitRun {
  code: number
  stdout: string
  stderr: string
  /** stdout + stderr, for asserting on a message wherever git chose to put it. */
  output: string
}

export function git(args: string[], cwd: string): GitRun {
  const res = spawnSync('git', args, { cwd, encoding: 'utf8', env: HERMETIC_ENV })
  const stdout = (res.stdout ?? '').trim()
  const stderr = (res.stderr ?? '').trim()
  return { code: res.status ?? 1, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n') }
}

/** Run the real script under test, with the same hermetic git config. */
export function runSparseBoard(script: string, arg: string, cwd: string): GitRun {
  const res = spawnSync('bash', [script, arg], { cwd, encoding: 'utf8', env: HERMETIC_ENV })
  const stdout = (res.stdout ?? '').trim()
  const stderr = (res.stderr ?? '').trim()
  return { code: res.status ?? 1, stdout, stderr, output: [stdout, stderr].filter(Boolean).join('\n') }
}

export interface BoardFixture {
  /** Working tree holding `main`. Stands in for the repo root -- the REAL board. */
  base: string
  /** Linked worktree, parked where this project parks them. */
  wt: string
  /** Every tracked path under the board, as `git ls-files` reports it. */
  boardFiles(cwd: string): string[]
  /** `git ls-files -t` rows under the board that are NOT skip-worktree. */
  liveBoardEntries(cwd: string): string[]
  status(cwd: string): string
}

export function makeBoardFixture(prefix = 'wt-board-sparse-'): BoardFixture {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const base = join(dir, 'base')
  const wt = join(base, '.claude', 'worktrees', 'feat')

  git(['init', '-q', '-b', 'main', 'base'], dir)

  // Mirrors the INTENT of the post-board-record-durability .gitignore (board
  // tracked, everything else under .rclaude/ not), without copying its bytes --
  // that file belongs to another card and this test must not pin its wording.
  writeFileSync(
    join(base, '.gitignore'),
    ['.claude/', '/.rclaude/*', '!/.rclaude/project/', '!/.rclaude/rclaude.json', ''].join('\n'),
  )
  writeFileSync(join(base, 'README.md'), 'root\n')
  mkdirSync(join(base, 'src'), { recursive: true })
  writeFileSync(join(base, 'src', 'a.txt'), 'a\n')
  mkdirSync(join(base, '.rclaude', 'project', 'cards'), { recursive: true })
  writeFileSync(join(base, '.rclaude', 'rclaude.json'), '{}\n')
  writeFileSync(join(base, '.rclaude', 'project', 'cards', 'c1.md'), 'c1\n')
  writeFileSync(join(base, '.rclaude', 'project', 'cards', 'c2.md'), 'c2\n')
  git(['add', '-A'], base)
  git(['commit', '-qm', 'init'], base)

  git(['worktree', 'add', '-q', '-b', 'worktree-feat', wt], base)

  return {
    base,
    wt,
    boardFiles: cwd => git(['ls-files', '--', '.rclaude/project'], cwd).stdout.split('\n').filter(Boolean),
    liveBoardEntries: cwd =>
      git(['ls-files', '-t', '--', '.rclaude/project'], cwd)
        .stdout.split('\n')
        .filter(l => l && !l.startsWith('S ')),
    status: cwd => git(['status', '--porcelain'], cwd).stdout,
  }
}

/** Commit a board change on main, so a worktree can merge it. */
export function churnBoardOnMain(fx: BoardFixture): void {
  writeFileSync(join(fx.base, '.rclaude', 'project', 'cards', 'c1.md'), 'c1-edited\n')
  writeFileSync(join(fx.base, '.rclaude', 'project', 'cards', 'c3.md'), 'c3\n')
  git(['add', '-A'], fx.base)
  git(['commit', '-qm', 'board churn'], fx.base)
}
