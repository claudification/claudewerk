/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest'
import type { Conversation, ProjectSettings } from '@/lib/types'
import { effectiveProject, flatten } from './batch-grouping'

const conv = (project: string): Conversation => ({ project }) as unknown as Conversation
const NO_SETTINGS: Record<string, ProjectSettings> = {}

const PARENT = 'claude://default/Users/jonas/projects/remote-claude'
const WT_A = `${PARENT}/.claude/worktrees/dispatch-overlay`
const WT_B = `${PARENT}/.claude/worktrees/excalidraw-p1`

describe('effectiveProject', () => {
  it('collapses a worktree URI to its parent project', () => {
    expect(effectiveProject(conv(WT_A))).toBe(PARENT)
    expect(effectiveProject(conv(WT_B))).toBe(PARENT)
  })

  it('leaves a non-worktree URI untouched', () => {
    expect(effectiveProject(conv(PARENT))).toBe(PARENT)
  })
})

describe('flatten group-by-project', () => {
  it('nests worktree conversations under their parent group instead of separate groups', () => {
    // parent conv + two sibling-worktree convs of the same parent
    const rows = [conv(PARENT), conv(WT_A), conv(WT_B)]
    const out = flatten(rows, true, NO_SETTINGS)
    const groups = out.filter(r => r.kind === 'group')
    expect(groups).toHaveLength(1)
    expect(groups[0]?.kind === 'group' && groups[0].project).toBe(PARENT)
    expect(groups[0]?.kind === 'group' && groups[0].count).toBe(3)
  })

  it('keeps distinct parent projects in distinct groups', () => {
    const other = 'claude://default/Users/jonas/projects/other-thing'
    const rows = [conv(PARENT), conv(WT_A), conv(other)]
    const out = flatten(rows, true, NO_SETTINGS)
    const groups = out.filter(r => r.kind === 'group')
    expect(groups).toHaveLength(2)
  })

  it('tags ungrouped rows with the effective (collapsed) project', () => {
    const out = flatten([conv(WT_A)], false, NO_SETTINGS)
    expect(out).toHaveLength(1)
    expect(out[0]?.kind === 'conv' && out[0].project).toBe(PARENT)
  })
})
