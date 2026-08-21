import { describe, expect, it } from 'bun:test'
import { EPIC_SOFT_LINK_STEP } from './epic-roster'
import { TASK_MODES, type TaskMode, taskMode } from './task-modes'

describe('task modes', () => {
  it('offers exactly work, refine and analyze', () => {
    expect(TASK_MODES.map(m => m.id)).toEqual(['work', 'refine', 'analyze'])
  })

  it('flips card status only for work', () => {
    expect(taskMode('work').flipsStatus).toBe(true)
    expect(taskMode('refine').flipsStatus).toBe(false)
    expect(taskMode('analyze').flipsStatus).toBe(false)
  })

  it('falls back to work for an unknown or missing id', () => {
    expect(taskMode(undefined).id).toBe('work')
    expect(taskMode('nonsense' as TaskMode).id).toBe('work')
  })

  it('gives the read-only modes a single-card instruction block', () => {
    expect(taskMode('refine').single).toContain('Do NOT change the card')
    expect(taskMode('analyze').single).toContain('Do NOT edit any file')
  })

  it('leaves work without a single-card override -- the wrapper already says it', () => {
    expect(taskMode('work').single).toBe('')
  })

  it('tells the batch modes not to touch status', () => {
    expect(taskMode('refine').instructions).toContain('Do NOT change any card')
    expect(taskMode('analyze').instructions).toContain('Change nothing on disk')
  })

  /**
   * BOTH REFINE SURFACES OR NEITHER. There are two definitions of "refine" in
   * this repo -- these three templates and `REFINER_INSTRUCTIONS` -- and both
   * files' headers already warn that they drifted apart once. A soft-link step
   * present in one and missing from the other is that drift, so it is asserted
   * against the shared constant rather than against a copy of the prose.
   */
  it('carries the epic soft-link step on BOTH refine surfaces', () => {
    expect(taskMode('refine').instructions).toContain(EPIC_SOFT_LINK_STEP)
    expect(taskMode('refine').single).toContain(EPIC_SOFT_LINK_STEP)
  })

  it('does not offer soft-linking to a mode that must change nothing', () => {
    expect(taskMode('analyze').instructions).not.toContain(EPIC_SOFT_LINK_STEP)
    expect(taskMode('analyze').single).not.toContain(EPIC_SOFT_LINK_STEP)
    expect(taskMode('work').instructions).not.toContain(EPIC_SOFT_LINK_STEP)
  })
})
