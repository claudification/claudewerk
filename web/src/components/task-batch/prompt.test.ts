/**
 * REGRESSION: the batch prompt emitted `.rclaude/project/<status>/<id>.md`.
 *
 * That lane layout was deleted in the board migration -- a card lives at
 * `cards/<id>.md` from creation to deletion and its lane is a frontmatter key.
 * So every "Work through these tasks" prompt pointed the agent at a file that
 * does not exist, and the failure was silent: the agent just could not read the
 * card it was told to work on.
 */

import { describe, expect, it } from 'vitest'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { batchOpenState, buildBatchPrompt, taskPromptLine } from './prompt'

function card(over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug: 'anvil-code-block',
    status: 'open',
    title: 'ANVIL @code block',
    tags: [],
    refs: [],
    created: '2026-08-14T02:30:00.000Z',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

describe('taskPromptLine', () => {
  it('points at the canonical cards/ path, never a lane directory', () => {
    expect(taskPromptLine(card())).toContain('.rclaude/project/cards/anvil-code-block.md')
  })

  it('emits the same path whatever lane the card sits in', () => {
    const lanes = ['inbox', 'open', 'in-progress', 'in-review', 'done', 'archived'] as const
    const paths = lanes.map(status => taskPromptLine(card({ status })).split('\n')[1].trim())
    expect(new Set(paths).size).toBe(1)
    expect(paths[0]).toBe('.rclaude/project/cards/anvil-code-block.md')
  })

  it('never emits a lane-shaped path', () => {
    for (const status of ['open', 'done', 'in-review'] as const) {
      expect(taskPromptLine(card({ status }))).not.toContain(`.rclaude/project/${status}/`)
    }
  })

  it('keeps title and priority', () => {
    expect(taskPromptLine(card({ priority: 'high' }))).toContain('- **ANVIL @code block** (high)')
  })

  it('omits the priority suffix when the card has none', () => {
    expect(taskPromptLine(card())).toContain('- **ANVIL @code block**\n')
    expect(taskPromptLine(card())).not.toContain('(undefined)')
  })
})

describe('buildBatchPrompt', () => {
  it('keeps the instructions above the task list', () => {
    const out = buildBatchPrompt('Do the thing.', [card()])
    expect(out.startsWith('Do the thing.\n\nTasks:\n')).toBe(true)
  })

  it('lists every card, one per selection', () => {
    const out = buildBatchPrompt('x', [card(), card({ slug: 'anvil-stamp-wire', title: 'Stamp wire' })])
    expect(out).toContain('.rclaude/project/cards/anvil-code-block.md')
    expect(out).toContain('.rclaude/project/cards/anvil-stamp-wire.md')
  })

  it('survives an empty selection without emitting a stray path', () => {
    expect(buildBatchPrompt('x', [])).toBe('x\n\nTasks:\n')
  })
})

describe('batchOpenState', () => {
  it('opens unscoped with nothing ticked when there is no payload', () => {
    const s = batchOpenState()
    expect(s.scope).toBeNull()
    expect(s.selected.size).toBe(0)
  })

  it('ticks the preselection', () => {
    expect([...batchOpenState({ preselect: ['a', 'b'] }).selected].toSorted()).toEqual(['a', 'b'])
  })

  it('carries the scope label through for the header chip', () => {
    const s = batchOpenState({ scope: ['a'], scopeLabel: 'ANVIL epic' })
    expect(s.scope?.label).toBe('ANVIL epic')
    expect(s.scope?.ids.has('a')).toBe(true)
  })

  it('a preselection without a scope stays unscoped', () => {
    expect(batchOpenState({ preselect: ['a'] }).scope).toBeNull()
  })

  it('an empty scope array is still a scope -- it means "nothing matches", not "whole board"', () => {
    expect(batchOpenState({ scope: [] }).scope?.ids.size).toBe(0)
  })
})
