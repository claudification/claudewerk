import { describe, expect, it } from 'bun:test'
import {
  assertWorktreeCorrectSpawn,
  computeWorktreeCwd,
  DispatchWorktreeError,
  isWorktreeCwd,
  stripWorktreeSegment,
} from './worktree'

describe('computeWorktreeCwd', () => {
  it('joins project root + worktree name', () => {
    expect(computeWorktreeCwd('/repo', 'fix-mic')).toBe('/repo/.claude/worktrees/fix-mic')
  })

  it('trims a trailing slash on the root', () => {
    expect(computeWorktreeCwd('/repo/', 'fix-mic')).toBe('/repo/.claude/worktrees/fix-mic')
  })

  it('folds a worktree root back before joining (no nesting)', () => {
    expect(computeWorktreeCwd('/repo/.claude/worktrees/other', 'fix-mic')).toBe('/repo/.claude/worktrees/fix-mic')
  })

  it('rejects an empty or slashed worktree name', () => {
    expect(() => computeWorktreeCwd('/repo', '')).toThrow(DispatchWorktreeError)
    expect(() => computeWorktreeCwd('/repo', 'a/b')).toThrow(DispatchWorktreeError)
  })
})

describe('stripWorktreeSegment', () => {
  it('folds a worktree path back to root', () => {
    expect(stripWorktreeSegment('/repo/.claude/worktrees/foo')).toBe('/repo')
    expect(stripWorktreeSegment('/repo/.claude/worktrees/foo/src/x.ts')).toBe('/repo')
  })

  it('leaves a non-worktree path unchanged', () => {
    expect(stripWorktreeSegment('/repo/src')).toBe('/repo/src')
  })
})

describe('isWorktreeCwd', () => {
  it('detects worktree paths', () => {
    expect(isWorktreeCwd('/repo/.claude/worktrees/foo')).toBe(true)
    expect(isWorktreeCwd('/repo/.claude/worktrees/foo/src')).toBe(true)
  })

  it('returns false for main / undefined', () => {
    expect(isWorktreeCwd('/repo')).toBe(false)
    expect(isWorktreeCwd(undefined)).toBe(false)
    expect(isWorktreeCwd(null)).toBe(false)
  })
})

describe('assertWorktreeCorrectSpawn -- THE GUARD', () => {
  it('allows a spawn with no worktree intended', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo' })).not.toThrow()
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo', worktreeName: null })).not.toThrow()
  })

  it('allows a correct worktree spawn (cwd inside the intended worktree)', () => {
    expect(() =>
      assertWorktreeCorrectSpawn({ cwd: '/repo/.claude/worktrees/fix-mic', worktreeName: 'fix-mic' }),
    ).not.toThrow()
  })

  it('REFUSES cwd=main when a worktree is intended (the original bug)', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo', worktreeName: 'fix-mic' })).toThrow(DispatchWorktreeError)
  })

  it('refusal message names the correct cwd to use', () => {
    try {
      assertWorktreeCorrectSpawn({ cwd: '/repo', worktreeName: 'fix-mic' })
      throw new Error('should have thrown')
    } catch (e) {
      expect((e as Error).message).toContain('/repo/.claude/worktrees/fix-mic')
      expect((e as Error).message).toContain('write into MAIN')
    }
  })

  it('REFUSES a cross-wired worktree (cwd in a different worktree than intended)', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo/.claude/worktrees/other', worktreeName: 'fix-mic' })).toThrow(
      DispatchWorktreeError,
    )
  })
})
