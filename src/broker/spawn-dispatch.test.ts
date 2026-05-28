import { describe, expect, it } from 'bun:test'
import type { SpawnRequest } from '../shared/spawn-schema'
import { computeTargetSameProjectAsCaller } from './spawn-dispatch'

function req(overrides: Partial<SpawnRequest> & { cwd: string }): SpawnRequest {
  return { ...overrides }
}

describe('computeTargetSameProjectAsCaller', () => {
  const caller = 'claude://default/Users/jonas/projects/remote-claude'

  it('returns false when callerProject is null', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '/Users/jonas/projects/remote-claude' }), null)).toBe(false)
  })

  it('returns false on empty / missing cwd', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '' }), caller)).toBe(false)
  })

  it('matches an identical absolute path', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '/Users/jonas/projects/remote-claude' }), caller)).toBe(true)
  })

  it('matches a worktree under the caller project (worktree-folded)', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: '/Users/jonas/projects/remote-claude/.claude/worktrees/foo' }),
        caller,
      ),
    ).toBe(true)
  })

  it('matches a nested worktree path beyond the worktree root', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: '/Users/jonas/projects/remote-claude/.claude/worktrees/foo/src/bar' }),
        caller,
      ),
    ).toBe(false) // a sibling subdir is NOT the project root after fold (path becomes /...repo/src/bar)
  })

  it('does NOT match a different absolute project', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '/Users/jonas/projects/other' }), caller)).toBe(false)
  })

  it('does NOT match a subdirectory of the caller project', () => {
    expect(
      computeTargetSameProjectAsCaller(req({ cwd: '/Users/jonas/projects/remote-claude/src' }), caller),
    ).toBe(false)
  })

  it('matches an identical claude:// URI', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: 'claude://default/Users/jonas/projects/remote-claude' }),
        caller,
      ),
    ).toBe(true)
  })

  it('matches a worktree expressed as a claude:// URI', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: 'claude://default/Users/jonas/projects/remote-claude/.claude/worktrees/foo' }),
        caller,
      ),
    ).toBe(true)
  })

  it('resolves a relative ./worktree path against the caller project root', () => {
    expect(
      computeTargetSameProjectAsCaller(req({ cwd: './.claude/worktrees/foo' }), caller),
    ).toBe(true)
  })

  it('resolves "." to the caller project root (same-project)', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '.' }), caller)).toBe(true)
  })

  it('returns false for ~ paths (sentinel resolves later; carve-out skipped)', () => {
    expect(computeTargetSameProjectAsCaller(req({ cwd: '~/projects/remote-claude' }), caller)).toBe(false)
  })

  it('returns false when req.sentinel overrides to a different host', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: '/Users/jonas/projects/remote-claude', sentinel: 'beast' }),
        caller,
      ),
    ).toBe(false)
  })

  it('returns false on cross-sentinel URI mismatch', () => {
    expect(
      computeTargetSameProjectAsCaller(
        req({ cwd: 'claude://beast/Users/jonas/projects/remote-claude' }),
        caller,
      ),
    ).toBe(false)
  })

  it('returns false when callerProject is unparseable garbage', () => {
    expect(
      computeTargetSameProjectAsCaller(req({ cwd: '/Users/jonas/projects/remote-claude' }), 'not-a-uri'),
    ).toBe(false)
  })
})
