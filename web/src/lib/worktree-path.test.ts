import { describe, expect, test } from 'vitest'
import { detectWorktree } from './worktree-path'

describe('detectWorktree', () => {
  test('matches a canonical worktree path', () => {
    const ctx = detectWorktree('/Users/jonas/projects/remote-claude/.claude/worktrees/foo')
    expect(ctx).toEqual({
      mainPath: '/Users/jonas/projects/remote-claude',
      worktreePath: '/Users/jonas/projects/remote-claude/.claude/worktrees/foo',
      worktreeName: 'foo',
    })
  })

  test('strips trailing slash from worktreePath', () => {
    const ctx = detectWorktree('/Users/jonas/projects/remote-claude/.claude/worktrees/foo/')
    expect(ctx?.worktreePath).toBe('/Users/jonas/projects/remote-claude/.claude/worktrees/foo')
    expect(ctx?.mainPath).toBe('/Users/jonas/projects/remote-claude')
  })

  test('hyphens and dots in worktree name', () => {
    const ctx = detectWorktree('/p/.claude/worktrees/feature-x.2')
    expect(ctx?.worktreeName).toBe('feature-x.2')
  })

  test('does not match the main project path', () => {
    expect(detectWorktree('/Users/jonas/projects/remote-claude')).toBeNull()
  })

  test('does not match the .claude dir itself', () => {
    expect(detectWorktree('/Users/jonas/projects/remote-claude/.claude')).toBeNull()
    expect(detectWorktree('/Users/jonas/projects/remote-claude/.claude/worktrees')).toBeNull()
  })

  test('does not match nested paths INSIDE a worktree', () => {
    // We intentionally only detect the worktree root, not arbitrary subpaths
    // under it. A launch from `.../worktrees/foo/src/` is an unusual case and
    // not in the design target -- the trigger paths we see in practice are
    // worktree roots.
    expect(detectWorktree('/Users/jonas/projects/remote-claude/.claude/worktrees/foo/src')).toBeNull()
  })

  test('does not match unrelated paths', () => {
    expect(detectWorktree('/Users/jonas/projects/other')).toBeNull()
    expect(detectWorktree('/')).toBeNull()
    expect(detectWorktree('')).toBeNull()
  })
})
