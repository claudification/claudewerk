/*
 * jsdom, though every test below is pure: `workspace-index.ts` also exports the
 * hook that reads the sidebar's order, and the conversations store it reaches
 * touches `localStorage` at module scope. Same import fallout as `axes.test.ts`.
 */

/**
 * THE WORKSPACE INDEX -- the fold behind the `^` axis.
 *
 * The claim worth proving is not "a map was built". It is that the map answers
 * the SAME question `workspace-membership.ts` answers, for every project, with
 * no case where the two disagree -- because the index is what actually runs and
 * `workspaceIdsForNode` is what the design says the answer is. The equivalence
 * test at the bottom is therefore the important one; the rest is its edges.
 */

import type { ProjectOrder } from '@shared/project-order-types'
import { describe, expect, it } from 'vitest'
import { projectDisplayName } from '@/lib/utils'
import { buildWorkspaceIndex } from '@/lib/workspace-index'
import { workspaceIdsForNode } from '@/lib/workspace-membership'

const RC = 'claude://default/Users/j/remote-claude'
const ANVIL = 'claude://default/Users/j/anvil-md'
const GATE = 'claude://default/Users/j/gate'

/** How a wall row spells a project: the display name, never the URI. */
const label = (uri: string) => projectDisplayName(uri)

/**
 * RC is in TWO workspaces, ANVIL is in ZERO, GATE is in one -- and reached
 * through a nested GROUP, because `workspaceTrees` holds group nodes too and a
 * project buried inside one is still in the workspace.
 */
const order: ProjectOrder = {
  tree: [
    { id: RC, type: 'project' },
    { id: ANVIL, type: 'project' },
    { id: GATE, type: 'project' },
  ],
  workspaces: [
    { id: 'ws-eng', name: 'Engineering' },
    { id: 'ws-client', name: 'Client Work' },
    { id: 'ws-empty', name: 'Someday' },
  ],
  workspaceTrees: {
    'ws-eng': [
      { id: RC, type: 'project' },
      { id: 'grp-1', type: 'group', name: 'shipped', children: [{ id: GATE, type: 'project' }] },
    ],
    'ws-client': [{ id: RC, type: 'project' }],
    'ws-empty': [],
  },
}

describe('buildWorkspaceIndex', () => {
  const index = buildWorkspaceIndex(order, label)

  it('gives a project in TWO workspaces both of them', () => {
    expect(index.byProject.get('remote-claude')).toEqual(['Engineering', 'Client Work'])
  })

  it('leaves a project in ZERO workspaces out of the map entirely', () => {
    // Absent, not `[]`: the matcher reads absent as "in no workspace", which is
    // a real answer, and it must never read as a wildcard.
    expect(index.byProject.has('anvil-md')).toBe(false)
  })

  it('finds a project nested inside a group', () => {
    expect(index.byProject.get('gate')).toEqual(['Engineering'])
  })

  it('lists every workspace name in sidebar order, empty ones included', () => {
    // `Someday` holds nothing, and still has to be suggestible -- otherwise the
    // only way to discover an empty workspace is to remember it exists.
    expect(index.names).toEqual(['Engineering', 'Client Work', 'Someday'])
  })

  it('unions two projects whose display names collide', () => {
    const twins: ProjectOrder = {
      tree: [],
      workspaces: [
        { id: 'ws-a', name: 'A' },
        { id: 'ws-b', name: 'B' },
      ],
      // Same path, two different sentinels -- the ordinary way two URIs end up
      // wearing one display name.
      workspaceTrees: {
        'ws-a': [{ id: 'claude://default/Users/j/remote-claude', type: 'project' }],
        'ws-b': [{ id: 'claude://thai/Users/j/remote-claude', type: 'project' }],
      },
    }
    // The `@` axis already collapses these two into one token, so the `^` axis
    // has to agree with it rather than pick a winner.
    expect(buildWorkspaceIndex(twins, label).byProject.get('remote-claude')).toEqual(['A', 'B'])
  })

  it('survives an order with no workspaces at all', () => {
    const bare = buildWorkspaceIndex({ tree: [{ id: RC, type: 'project' }] }, label)
    expect(bare.names).toEqual([])
    expect(bare.byProject.size).toBe(0)
  })
})

describe('the index agrees with workspace-membership, project by project', () => {
  /** The design's answer: the reverse lookup, by node id, turned into names. */
  function membershipNames(uri: string): string[] {
    const ids = workspaceIdsForNode(order, uri)
    return (order.workspaces ?? []).filter(ws => ids.has(ws.id)).map(ws => ws.name)
  }

  it('returns exactly what workspaceIdsForNode returns, for every project', () => {
    // `buildWorkspaceIndex` walks FORWARD (projects per workspace) where the
    // card describes the walk BACKWARD (workspaces per project). Same trees,
    // same answer -- proven here rather than asserted in a comment, because the
    // forward walk is what ships and one pass beats one walk per row.
    const index = buildWorkspaceIndex(order, label)
    for (const uri of [RC, ANVIL, GATE]) {
      const fromIndex = index.byProject.get(label(uri)) ?? []
      expect(`${uri}: ${[...fromIndex].sort().join()}`).toBe(`${uri}: ${membershipNames(uri).sort().join()}`)
    }
  })
})
