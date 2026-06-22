/**
 * Tests for the shared worktree-correctness guard -- the rule that refuses the
 * cwd=main+worktree-param bug (the 2026-06-22 incident).
 */
import { describe, expect, test } from 'bun:test'
import {
  assertWorktreeCorrectSpawn,
  computeWorktreeCwd,
  isWorktreeCwd,
  stripWorktreeSegment,
  WorktreeCorrectError,
} from './worktree-correct'

describe('computeWorktreeCwd', () => {
  test('joins the convention path', () => {
    expect(computeWorktreeCwd('/repo', 'fix-mic')).toBe('/repo/.claude/worktrees/fix-mic')
  })
  test('folds a worktree root back before re-joining (no nesting)', () => {
    expect(computeWorktreeCwd('/repo/.claude/worktrees/other', 'fix-mic')).toBe('/repo/.claude/worktrees/fix-mic')
  })
  test('trims a trailing slash on the root', () => {
    expect(computeWorktreeCwd('/repo/', 'x')).toBe('/repo/.claude/worktrees/x')
  })
  test('rejects an empty or slashed name', () => {
    expect(() => computeWorktreeCwd('/repo', '')).toThrow(WorktreeCorrectError)
    expect(() => computeWorktreeCwd('/repo', 'a/b')).toThrow(WorktreeCorrectError)
  })
})

describe('stripWorktreeSegment / isWorktreeCwd', () => {
  test('strips the segment', () => {
    expect(stripWorktreeSegment('/repo/.claude/worktrees/x/src')).toBe('/repo')
    expect(stripWorktreeSegment('/repo')).toBe('/repo')
  })
  test('detects worktree paths', () => {
    expect(isWorktreeCwd('/repo/.claude/worktrees/x')).toBe(true)
    expect(isWorktreeCwd('/repo')).toBe(false)
    expect(isWorktreeCwd(undefined)).toBe(false)
  })
})

describe('assertWorktreeCorrectSpawn', () => {
  test('no worktree intended -> always passes', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo', worktreeName: undefined })).not.toThrow()
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo' })).not.toThrow()
  })
  test('intended worktree + cwd is that worktree -> passes', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo/.claude/worktrees/fix', worktreeName: 'fix' })).not.toThrow()
  })
  test('THE BUG: intended worktree but cwd is main -> refuses', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo', worktreeName: 'fix' })).toThrow(/would write into MAIN/)
  })
  test('cross-wired worktree -> refuses', () => {
    expect(() => assertWorktreeCorrectSpawn({ cwd: '/repo/.claude/worktrees/other', worktreeName: 'fix' })).toThrow(
      /cwd is in worktree 'other'/,
    )
  })
})
