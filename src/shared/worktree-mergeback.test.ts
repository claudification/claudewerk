import { describe, expect, test } from 'bun:test'
import {
  exitFastForwardAllowed,
  exitFastForwardAllowedFromEnv,
  heldBranchDiag,
  mergeBackInstructionsWanted,
  WORKTREE_MERGEBACK_ENV,
  worktreeMergeBackEnv,
} from './worktree-mergeback'

describe('the two seams have opposite defaults, on purpose', () => {
  test('absent: the prompt fragment stays off, the exit fast-forward stays on', () => {
    // Neither default is arbitrary. The fragment was always opt-in (only the
    // dashboard's worktree checkbox asked for it); the fast-forward was always
    // opt-out (it is the anti-stranding defence). Folding them into one
    // predicate would silently flip one of them.
    expect(mergeBackInstructionsWanted(undefined)).toBe(false)
    expect(exitFastForwardAllowed(undefined)).toBe(true)
  })

  test('true: both act', () => {
    expect(mergeBackInstructionsWanted(true)).toBe(true)
    expect(exitFastForwardAllowed(true)).toBe(true)
  })

  test('FALSE: neither acts -- this is the value the whole fix turns on', () => {
    expect(mergeBackInstructionsWanted(false)).toBe(false)
    expect(exitFastForwardAllowed(false)).toBe(false)
  })
})

describe('the wire hop', () => {
  test('only an explicit false emits an env entry', () => {
    expect(worktreeMergeBackEnv(false)).toEqual({ [WORKTREE_MERGEBACK_ENV]: '0' })
    // An unmodified spawn's env must be byte-identical to what it was before.
    expect(worktreeMergeBackEnv(undefined)).toEqual({})
    expect(worktreeMergeBackEnv(true)).toEqual({})
  })

  test('the host reads back exactly what the sentinel set', () => {
    expect(exitFastForwardAllowedFromEnv(worktreeMergeBackEnv(false))).toBe(false)
    expect(exitFastForwardAllowedFromEnv(worktreeMergeBackEnv(undefined))).toBe(true)
    expect(exitFastForwardAllowedFromEnv(worktreeMergeBackEnv(true))).toBe(true)
  })

  test('an unset or junk env value means the defence stays on', () => {
    expect(exitFastForwardAllowedFromEnv({})).toBe(true)
    expect(exitFastForwardAllowedFromEnv({ [WORKTREE_MERGEBACK_ENV]: '' })).toBe(true)
    expect(exitFastForwardAllowedFromEnv({ [WORKTREE_MERGEBACK_ENV]: '1' })).toBe(true)
    expect(exitFastForwardAllowedFromEnv({ [WORKTREE_MERGEBACK_ENV]: 'false' })).toBe(true)
  })
})

describe('heldBranchDiag', () => {
  test('names the branch, the count and who merges it', () => {
    const line = heldBranchDiag('worktree-epic/e/card', 3, 'main')
    expect(line).toContain('worktree-epic/e/card')
    expect(line).toContain('3 commits')
    expect(line).toContain('left unmerged')
    expect(line).toContain('werk-master')
    // A stranded branch and a held one must never read the same.
    expect(line).toContain('preserved on purpose')
  })

  test('singular commit reads as English', () => {
    expect(heldBranchDiag('b', 1, 'main')).toContain('1 commit ahead')
  })
})
