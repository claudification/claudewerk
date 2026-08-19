/**
 * @vitest-environment node
 */
/**
 * Run-length grouping. The property that matters: CHRONOLOGY IS NEVER
 * REORDERED. Grouping only collapses ADJACENT repeats, so the same project
 * legitimately appears more than once down the timeline.
 */

import { describe, expect, it } from 'vitest'
import type { CommitRow } from '@/lib/commits'
import { groupIntoRuns } from './group-run-length'

const A = 'claude://default/proj-a'
const B = 'claude://default/proj-b'

function c(hash: string, repoUri: string, conversationId: string | null): CommitRow {
  return { hash, shortHash: hash.slice(0, 8), repoUri, conversationId } as CommitRow
}

describe('groupIntoRuns', () => {
  it('reproduces the shape from the spec: a project appears AGAIN later', () => {
    // PROJ A / conv-1 : 1, 2  |  PROJ B / conv-2 : 3  |  PROJ A / conv-3 : 4, conv-4 : 5
    const runs = groupIntoRuns([
      c('h1', A, 'conv-1'),
      c('h2', A, 'conv-1'),
      c('h3', B, 'conv-2'),
      c('h4', A, 'conv-3'),
      c('h5', A, 'conv-4'),
    ])

    expect(runs.map(r => [r.projectUri, r.conversationId, r.commits.length])).toEqual([
      [A, 'conv-1', 2],
      [B, 'conv-2', 1],
      [A, 'conv-3', 1],
      [A, 'conv-4', 1],
    ])
    // Project A opens a SECOND block rather than absorbing the later commits.
    expect(runs.filter(r => r.projectUri === A)).toHaveLength(3)
  })

  it('never reorders -- the flat sequence out equals the sequence in', () => {
    const input = [c('h1', A, 'conv-1'), c('h2', B, 'conv-2'), c('h3', A, 'conv-1'), c('h4', A, 'conv-1')]
    const flat = groupIntoRuns(input).flatMap(r => r.commits.map(x => x.hash))
    expect(flat).toEqual(['h1', 'h2', 'h3', 'h4'])
  })

  it('splits a run when the conversation changes inside one project', () => {
    const runs = groupIntoRuns([c('h1', A, 'conv-1'), c('h2', A, 'conv-2')])
    expect(runs).toHaveLength(2)
    // Second run continues the same project -- the renderer mutes the header.
    expect(runs[1].continuesProject).toBe(true)
  })

  it('marks the first run of a project as not continuing', () => {
    const runs = groupIntoRuns([c('h1', A, 'conv-1'), c('h2', B, 'conv-2')])
    expect(runs[0].continuesProject).toBe(false)
    expect(runs[1].continuesProject).toBe(false)
  })

  it('groups terminal (human) commits under their own run', () => {
    const runs = groupIntoRuns([c('h1', A, null), c('h2', A, null), c('h3', A, 'conv-1')])
    expect(runs).toHaveLength(2)
    expect(runs[0].conversationId).toBeNull()
    expect(runs[0].commits).toHaveLength(2)
  })

  it('handles an empty feed', () => {
    expect(groupIntoRuns([])).toEqual([])
  })

  it('gives every run a distinct key', () => {
    const runs = groupIntoRuns([c('h1', A, 'conv-1'), c('h2', B, 'conv-2'), c('h3', A, 'conv-1')])
    expect(new Set(runs.map(r => r.key)).size).toBe(runs.length)
  })
})
