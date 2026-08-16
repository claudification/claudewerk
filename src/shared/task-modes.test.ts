import { describe, expect, it } from 'bun:test'
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
})
