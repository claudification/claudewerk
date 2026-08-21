/**
 * The project board (`.rclaude/project/`) must be TRACKED by git, and nothing
 * else under `.rclaude/` may be.
 *
 * WHY THIS EXISTS (2026-08-21): the board was in no backup and no git. 604
 * cards, 7.1 MB, zero copies. The broker backup covers the broker's own
 * cacheDir (store.db, analytics.db, blobs/, ...) and structurally cannot reach
 * into a project tree -- CWD IS INFORMATIONAL, with `lint:boundary` Rule 4
 * behind it. So git is the only durability the board gets.
 *
 * Somebody had already tried to fix this. `.rclaude/.gitignore` said
 * `!project/` and `!rclaude.json`, and those negations had NEVER once taken
 * effect: the root `.gitignore` excluded the `.rclaude/` DIRECTORY, and git
 * never descends into an excluded directory, so the nested file was not even
 * read. The intent was written down, the mechanism was wrong, and nothing said
 * so. That is the exact failure this guard exists to make loud.
 *
 * BOTH directions are asserted on purpose. A fix that over-corrects is just as
 * silent as the one that under-corrected, and over-correcting here stages
 * `.rclaude/settings/` -- 687 MB on this machine, measured. A one-directional
 * test would have waved that through.
 *
 * The test is hermetic: it copies the REAL root `.gitignore` into a throwaway
 * repo and materialises a realistic `.rclaude/` tree. That way it exercises the
 * shipped rules (a regression in them fails here) without depending on which
 * files happen to exist in the checkout running it.
 */

import { describe, expect, it } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

function repoRoot(): string {
  const git = Bun.spawnSync(['git', 'rev-parse', '--show-toplevel'], { cwd: import.meta.dir })
  const out = git.stdout.toString().trim()
  return out || join(import.meta.dir, '..', '..')
}

/** A file tree mirroring what actually sits under `.rclaude/` on a working
 *  machine, plus the `.rclaude/` dirs that appear in OTHER trees (worktrees,
 *  nested projects) and must stay ignored wherever they turn up. */
const FIXTURE_FILES = [
  // the board -- the whole point
  '.rclaude/project/priority.md',
  '.rclaude/project/cards/werk-epic.md',
  '.rclaude/project/cards/board-record-durability.md',
  '.rclaude/project/epics/epic-morning-report/log.md',
  '.rclaude/rclaude.json',
  // session temp files, secrets, stream logs -- 687 MB of them in real life
  '.rclaude/settings/agent/settings.json',
  '.rclaude/headless-0fb84979-7d57-4b9a-abc4-afa1a7a46254.ndjsonl',
  '.rclaude/mcp-21d482e6-18b9-43fd-9669-ad88ca2382fb.json',
  '.rclaude/prompt-21d482e6-18b9-43fd-9669-ad88ca2382fb.txt',
  '.rclaude/settings-a7947e59-edd4-4608-936f-38024e58881c.json',
  '.rclaude/docs/scratch.md',
  '.rclaude/tasks/legacy.md',
  '.rclaude/.gitignore',
  // machine-local snapshot taken by the lane-folder -> frontmatter migration.
  // `project-doctor-layout.ts` already treats this prefix as not-a-card.
  '.rclaude/project/.upgrade-backup-2026-08-11T18-08-04/done/old-card.md',
  // a conversation that ran with cwd = a worktree writes its own .rclaude/
  '.claude/worktrees/some-branch/.rclaude/headless-deadbeef.ndjsonl',
  '.claude/worktrees/some-branch/.rclaude/project/cards/stray.md',
  // and one nested inside the board itself, seen in the wild
  '.rclaude/project/.rclaude/junk.md',
  'design/.rclaude/junk.md',
]

/** Paths that MUST end up tracked-and-addable. */
const MUST_BE_TRACKABLE = [
  '.rclaude/project/priority.md',
  '.rclaude/project/cards/werk-epic.md',
  '.rclaude/project/cards/board-record-durability.md',
  '.rclaude/project/epics/epic-morning-report/log.md',
  '.rclaude/rclaude.json',
]

/** Paths that MUST stay ignored. Staging any of these is the 687 MB mistake. */
const MUST_BE_IGNORED = [
  '.rclaude/settings/agent/settings.json',
  '.rclaude/headless-0fb84979-7d57-4b9a-abc4-afa1a7a46254.ndjsonl',
  '.rclaude/mcp-21d482e6-18b9-43fd-9669-ad88ca2382fb.json',
  '.rclaude/prompt-21d482e6-18b9-43fd-9669-ad88ca2382fb.txt',
  '.rclaude/settings-a7947e59-edd4-4608-936f-38024e58881c.json',
  '.rclaude/docs/scratch.md',
  '.rclaude/tasks/legacy.md',
  '.rclaude/.gitignore',
  '.rclaude/project/.upgrade-backup-2026-08-11T18-08-04/done/old-card.md',
  '.claude/worktrees/some-branch/.rclaude/headless-deadbeef.ndjsonl',
  '.claude/worktrees/some-branch/.rclaude/project/cards/stray.md',
  '.rclaude/project/.rclaude/junk.md',
  'design/.rclaude/junk.md',
]

/**
 * A throwaway repo carrying the real root `.gitignore` and the fixture tree.
 * `core.excludesFile=` and `--no-global` keep a developer's ~/.gitignore out of
 * the answer, so the verdict is about the repo's rules and nothing else.
 */
function scratchRepo(): { dir: string; untracked: () => string[]; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'board-gitignore-'))
  const run = (...args: string[]) =>
    Bun.spawnSync(['git', '-c', 'core.excludesFile=', ...args], {
      cwd: dir,
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' },
    })

  run('init', '--quiet', '.')
  writeFileSync(join(dir, '.gitignore'), readFileSync(join(repoRoot(), '.gitignore'), 'utf8'))
  for (const rel of FIXTURE_FILES) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true })
    writeFileSync(join(dir, rel), 'fixture\n')
  }

  return {
    dir,
    untracked: () =>
      run('status', '--porcelain', '--untracked-files=all')
        .stdout.toString()
        .split('\n')
        .filter(Boolean)
        .map(line => line.slice(3).trim()),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

describe('root .gitignore: the project board is the only durable copy', () => {
  const repo = scratchRepo()
  const untracked = repo.untracked()

  it('offers every board file to git', () => {
    // `git status -uall` is the honest question: what would `git add` take?
    expect(MUST_BE_TRACKABLE.filter(p => !untracked.includes(p))).toEqual([])
  })

  it('offers nothing else from .rclaude/ -- staging settings/ is 687 MB', () => {
    expect(MUST_BE_IGNORED.filter(p => untracked.includes(p))).toEqual([])
  })

  it('leaves .rclaude/ in OTHER trees fully ignored', () => {
    // The old rule was `.rclaude/` (any depth). Rewriting it to `/.rclaude/*`
    // alone would silently un-ignore every worktree's session logs.
    expect(untracked.filter(p => p.startsWith('.claude/') || p.startsWith('design/'))).toEqual([])
  })

  it('adds no path outside the board', () => {
    const strays = untracked.filter(
      p => p !== '.gitignore' && p !== '.rclaude/rclaude.json' && !p.startsWith('.rclaude/project/'),
    )
    expect(strays).toEqual([])
  })

  repo.cleanup()
})

describe('this checkout: git check-ignore agrees, both directions', () => {
  const root = repoRoot()
  const ignored = (path: string) =>
    Bun.spawnSync(['git', 'check-ignore', '--quiet', '--no-index', '--', path], { cwd: root }).exitCode === 0

  it('does not ignore a board card', () => {
    expect(ignored('.rclaude/project/cards/werk-epic.md')).toBe(false)
  })

  it('ignores .rclaude/settings/', () => {
    expect(ignored('.rclaude/settings/some-session.json')).toBe(true)
  })

  it('ignores a headless stream log', () => {
    expect(ignored('.rclaude/headless-0fb84979-7d57-4b9a-abc4-afa1a7a46254.ndjsonl')).toBe(true)
  })
})
