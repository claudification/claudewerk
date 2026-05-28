/**
 * End-to-end test of scripts/worktree-create.sh against a tmp git repo.
 *
 * Verifies the idempotency fix shipped to recover from "branch already
 * exists" failures: a parent spawning a child into the same worktree must
 * not crash the agent host. See the SpawnFailed enrichment for the
 * visibility half of the fix.
 */

import { describe, expect, test } from 'bun:test'
import { execSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

const HOOK = resolve(import.meta.dir, '..', '..', 'scripts', 'worktree-create.sh')

function fresh(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wtcreate-'))
  // Use real path -- macOS /var -> /private/var symlink trips `git worktree
  // list --porcelain` reporting the real path while we'd otherwise compare
  // against the symlink one.
  const real = execSync(`cd "${dir}" && pwd -P`).toString().trim()
  const run = (cmd: string) => execSync(cmd, { cwd: real, stdio: 'pipe' })
  run('git init -q')
  run('git config user.email a@b')
  run('git config user.name a')
  run('echo seed > x')
  run('git add x')
  run('git commit -q -m seed')
  return real
}

function runHook(repo: string, name: string): { exit: number; stdout: string; stderr: string } {
  const res = Bun.spawnSync({
    cmd: ['bash', HOOK],
    cwd: repo,
    stdin: Buffer.from(JSON.stringify({ name })),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return {
    exit: res.exitCode ?? -1,
    stdout: new TextDecoder().decode(res.stdout).trim(),
    stderr: new TextDecoder().decode(res.stderr),
  }
}

describe('worktree-create.sh', () => {
  test('FRESH: creates worktree + branch when neither exists', () => {
    const repo = fresh()
    const r = runHook(repo, 'feat-a')
    expect(r.exit).toBe(0)
    expect(r.stdout).toBe(`${repo}/.claude/worktrees/feat-a`)
    expect(existsSync(r.stdout)).toBe(true)
    expect(r.stderr).toContain("Preparing worktree (new branch 'worktree-feat-a')")
  })

  test('REUSE: re-running with same name + path is idempotent (exit 0, REUSE log)', () => {
    const repo = fresh()
    const first = runHook(repo, 'feat-b')
    expect(first.exit).toBe(0)

    const second = runHook(repo, 'feat-b')
    expect(second.exit).toBe(0)
    expect(second.stdout).toBe(first.stdout)
    expect(second.stderr).toContain('REUSE existing worktree')
    expect(second.stderr).toContain('feat-b')
  })

  test('ATTACH: re-running after the worktree dir is removed reuses the branch', () => {
    const repo = fresh()
    const first = runHook(repo, 'feat-c')
    expect(first.exit).toBe(0)
    const wtPath = first.stdout
    // Remove the worktree (branch ref stays).
    execSync(`git worktree remove "${wtPath}"`, { cwd: repo })
    expect(existsSync(wtPath)).toBe(false)

    const second = runHook(repo, 'feat-c')
    expect(second.exit).toBe(0)
    expect(second.stdout).toBe(wtPath)
    expect(second.stderr).toContain('ATTACH existing branch worktree-feat-c')
    expect(existsSync(wtPath)).toBe(true)
  })

  test('ERROR: path already used by a different branch -> exit 1, no clobber', () => {
    const repo = fresh()
    const wtPath = `${repo}/.claude/worktrees/feat-d`
    execSync(`mkdir -p "${dirname(wtPath)}"`, { cwd: repo })
    execSync(`git worktree add "${wtPath}" -b worktree-other HEAD`, { cwd: repo })

    const r = runHook(repo, 'feat-d')
    expect(r.exit).toBe(1)
    expect(r.stderr).toContain('ERROR')
    expect(r.stderr).toContain("'worktree-other'")
    expect(r.stderr).toContain("'worktree-feat-d'")
  })
})
