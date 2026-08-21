/**
 * `ensureRclaudeDir` creates the runtime state directory a host writes into.
 *
 * Nothing under `.rclaude/` is tracked in git -- `7ee496a4` settled that, and
 * `72a8d449` made the generator emit a bare `*`. The previous version of this
 * file asserted the opposite (an anchored .gitignore with `!/project/`
 * negations) and sat RED on main for hours after the reversal; it was deleted
 * wholesale in `6f8f7dc2`, together with a lint gate -- `lint:no-config-tests`
 * -- that now refuses any test asserting version-control configuration.
 *
 * That gate is why the ignore-file contract is absent here rather than
 * restated: its token ban matches the filename itself, so even a
 * bytes-of-the-generated-file assertion cannot be written. Filed as
 * `lint-no-config-tests-bans-the-bytes-test`.
 *
 * What is left is the directory work, which is ours and is untested otherwise:
 * the layout it creates, the owner-only mode on `settings/`, and the
 * `tasks/` -> `project/` rename it carries for pre-rename projects.
 */

import { describe, expect, it } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureRclaudeDir } from './ensure-rclaude-dir'

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'ensure-rclaude-'))
}

describe('ensureRclaudeDir', () => {
  it('creates settings/ owner-only and project/ readable, and returns the dir', () => {
    const cwd = scratch()
    const dir = ensureRclaudeDir(cwd)

    expect(dir).toBe(join(cwd, '.rclaude'))
    expect(existsSync(join(dir, 'settings'))).toBe(true)
    expect(existsSync(join(dir, 'project'))).toBe(true)
    // settings/ holds secrets and stream logs: no group or world bits at all.
    expect(statSync(join(dir, 'settings')).mode & 0o077).toBe(0)
    // project/ is the board; tooling reads it, so it stays readable.
    expect(statSync(join(dir, 'project')).mode & 0o400).toBe(0o400)

    rmSync(cwd, { recursive: true, force: true })
  })

  it('migrates a pre-rename tasks/ directory to project/', () => {
    const cwd = scratch()
    mkdirSync(join(cwd, '.rclaude', 'tasks'), { recursive: true })
    writeFileSync(join(cwd, '.rclaude', 'tasks', 'card.md'), 'body\n')

    ensureRclaudeDir(cwd)

    expect(existsSync(join(cwd, '.rclaude', 'tasks'))).toBe(false)
    expect(readFileSync(join(cwd, '.rclaude', 'project', 'card.md'), 'utf8')).toBe('body\n')

    rmSync(cwd, { recursive: true, force: true })
  })

  it('never merges tasks/ into an existing project/', () => {
    const cwd = scratch()
    mkdirSync(join(cwd, '.rclaude', 'tasks'), { recursive: true })
    mkdirSync(join(cwd, '.rclaude', 'project'), { recursive: true })
    writeFileSync(join(cwd, '.rclaude', 'tasks', 'old.md'), 'old\n')
    writeFileSync(join(cwd, '.rclaude', 'project', 'new.md'), 'new\n')

    ensureRclaudeDir(cwd)

    // Both survive untouched: a rename here would silently bury one of them.
    expect(readFileSync(join(cwd, '.rclaude', 'tasks', 'old.md'), 'utf8')).toBe('old\n')
    expect(readFileSync(join(cwd, '.rclaude', 'project', 'new.md'), 'utf8')).toBe('new\n')

    rmSync(cwd, { recursive: true, force: true })
  })

  it('is idempotent and preserves what is already there', () => {
    const cwd = scratch()
    ensureRclaudeDir(cwd)
    writeFileSync(join(cwd, '.rclaude', 'project', 'card.md'), 'kept\n')

    expect(ensureRclaudeDir(cwd)).toBe(join(cwd, '.rclaude'))
    expect(readFileSync(join(cwd, '.rclaude', 'project', 'card.md'), 'utf8')).toBe('kept\n')

    rmSync(cwd, { recursive: true, force: true })
  })
})
