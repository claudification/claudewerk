/**
 * What each launch mode implies for the lifecycle switches.
 *
 * The two failures pinned here are both silent: an ANALYZE run inheriting
 * auto-commit from the last WORK launch (an agent told to change nothing, told
 * to commit), and that same run then SAVING "no commit, no worktree" as the
 * remembered default so the next real launch quietly stopped committing.
 */

import { describe, expect, it } from 'vitest'
import { modeDefaults, persistsDefaults } from './run-task-mode'

const SAVED = { useWorktree: true, autoCommit: true }

describe('modeDefaults', () => {
  it('leaves work alone -- the user picked those', () => {
    expect(modeDefaults('work', SAVED)).toEqual(SAVED)
    expect(modeDefaults('work', { useWorktree: false, autoCommit: false })).toEqual({
      useWorktree: false,
      autoCommit: false,
    })
  })

  it('never branches for refine -- the card edit would strand on the branch', () => {
    expect(modeDefaults('refine', SAVED).useWorktree).toBe(false)
  })

  it('still commits a refine, because it changed a file', () => {
    expect(modeDefaults('refine', { useWorktree: true, autoCommit: false }).autoCommit).toBe(true)
  })

  it('gives analyze neither, whatever was saved', () => {
    expect(modeDefaults('analyze', SAVED)).toEqual({ useWorktree: false, autoCommit: false })
  })
})

describe('persistsDefaults', () => {
  it('only work writes the remembered defaults back', () => {
    expect(persistsDefaults('work')).toBe(true)
    expect(persistsDefaults('refine')).toBe(false)
    expect(persistsDefaults('analyze')).toBe(false)
  })
})
