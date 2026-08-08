/**
 * The cwd -> transcript-dir slug, which more than one component derives.
 *
 * Regression: the sentinel used to slug only '/', while CC slugs '/', '.' AND
 * '_'. Every `.claude/worktrees/...` path therefore resolved to a directory
 * that does not exist and the CC-session picker silently returned [] for every
 * worktree conversation.
 */
import { describe, expect, test } from 'bun:test'
import { transcriptSlug } from './transcript-path'

describe('transcriptSlug', () => {
  test('slugs path separators', () => {
    expect(transcriptSlug('/Users/jonas/projects/remote-claude')).toBe('-Users-jonas-projects-remote-claude')
  })

  test('slugs dots -- the worktree case that was broken', () => {
    expect(transcriptSlug('/Users/jonas/projects/remote-claude/.claude/worktrees/fork-spike')).toBe(
      '-Users-jonas-projects-remote-claude--claude-worktrees-fork-spike',
    )
  })

  test('slugs underscores', () => {
    expect(transcriptSlug('/repo/my_project')).toBe('-repo-my-project')
  })

  test('handles all three in one path', () => {
    expect(transcriptSlug('/a/b.c/d_e')).toBe('-a-b-c-d-e')
  })
})
