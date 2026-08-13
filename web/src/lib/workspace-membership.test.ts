// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectOrder } from '@/lib/types'
import {
  findNode,
  isProjectInWorkspace,
  loadValidWorkspaceConversation,
  removeNodeDeep,
  saveLastWorkspaceConversation,
  WORKSPACE_ALL,
  workspaceIdsForNode,
} from './workspace-membership'

const order: ProjectOrder = {
  tree: [],
  workspaceTrees: {
    ws1: [
      { id: 'claude:///a', type: 'project' },
      { id: 'g1', type: 'group', name: 'Group', children: [{ id: 'claude:///b', type: 'project' }] },
    ],
    ws2: [{ id: 'claude:///a', type: 'project' }], // same project also lives in ws2 (many-to-many)
  },
}

describe('isProjectInWorkspace (membership is per-workspace, not single-home)', () => {
  it('is true for EVERY workspace a project belongs to', () => {
    expect(isProjectInWorkspace(order, 'ws1', 'claude:///a')).toBe(true)
    expect(isProjectInWorkspace(order, 'ws2', 'claude:///a')).toBe(true)
  })

  it('finds a project nested inside a group', () => {
    expect(isProjectInWorkspace(order, 'ws1', 'claude:///b')).toBe(true)
  })

  it('is false for a workspace the project is not in', () => {
    expect(isProjectInWorkspace(order, 'ws2', 'claude:///b')).toBe(false)
  })
})

describe('workspaceIdsForNode (ZERO, ONE or MANY -- never "the" workspace)', () => {
  it('returns EVERY workspace holding the project, not just the first', () => {
    expect(workspaceIdsForNode(order, 'claude:///a')).toEqual(new Set(['ws1', 'ws2']))
  })

  it('counts a project nested inside a group as a member', () => {
    expect(workspaceIdsForNode(order, 'claude:///b')).toEqual(new Set(['ws1']))
  })

  it('answers for a GROUP node too -- a whole group can be a member', () => {
    expect(workspaceIdsForNode(order, 'g1')).toEqual(new Set(['ws1']))
  })

  it('returns an empty set for a node in no workspace', () => {
    expect(workspaceIdsForNode(order, 'claude:///nowhere')).toEqual(new Set())
  })
})

describe('removeNodeDeep (a nested member must be removable too)', () => {
  it('drops a top-level project node', () => {
    expect(removeNodeDeep(order.workspaceTrees?.ws2 ?? [], 'claude:///a')).toEqual([])
  })

  it('drops a project nested inside a group, keeping the group', () => {
    const next = removeNodeDeep(order.workspaceTrees?.ws1 ?? [], 'claude:///b')
    expect(next).toEqual([
      { id: 'claude:///a', type: 'project' },
      { id: 'g1', type: 'group', name: 'Group', children: [] },
    ])
  })

  it('drops a group WITH its children', () => {
    expect(removeNodeDeep(order.workspaceTrees?.ws1 ?? [], 'g1')).toEqual([{ id: 'claude:///a', type: 'project' }])
  })

  it('leaves the tree untouched when the node is absent', () => {
    const tree = order.workspaceTrees?.ws2 ?? []
    expect(removeNodeDeep(tree, 'claude:///zzz')).toEqual(tree)
  })
})

describe('findNode (a group is copied whole into a workspace, not faked as a project)', () => {
  const globalTree = order.workspaceTrees?.ws1 ?? []

  it('finds a group node with its children intact', () => {
    expect(findNode(globalTree, 'g1')).toEqual({
      id: 'g1',
      type: 'group',
      name: 'Group',
      children: [{ id: 'claude:///b', type: 'project' }],
    })
  })

  it('finds a project nested inside a group', () => {
    expect(findNode(globalTree, 'claude:///b')).toEqual({ id: 'claude:///b', type: 'project' })
  })

  it('returns undefined for an unknown id', () => {
    expect(findNode(globalTree, 'nope')).toBeUndefined()
  })
})

describe('workspace -> last conversation memory (forward-only, no reverse lookup)', () => {
  beforeEach(() => localStorage.clear())
  const anyValid = () => true

  it('returns undefined before anything is recorded', () => {
    expect(loadValidWorkspaceConversation('ws1', anyValid)).toBeUndefined()
  })

  it('remembers, per workspace, its last selected conversation independently', () => {
    saveLastWorkspaceConversation('ws1', 'convA')
    saveLastWorkspaceConversation('ws2', 'convB')
    saveLastWorkspaceConversation(WORKSPACE_ALL, 'convC')
    expect(loadValidWorkspaceConversation('ws1', anyValid)).toBe('convA')
    expect(loadValidWorkspaceConversation('ws2', anyValid)).toBe('convB')
    expect(loadValidWorkspaceConversation(WORKSPACE_ALL, anyValid)).toBe('convC')
  })

  it('overwrites on re-record and clears with null', () => {
    saveLastWorkspaceConversation('ws1', 'convA')
    saveLastWorkspaceConversation('ws1', 'convB')
    expect(loadValidWorkspaceConversation('ws1', anyValid)).toBe('convB')
    saveLastWorkspaceConversation('ws1', null)
    expect(loadValidWorkspaceConversation('ws1', anyValid)).toBeUndefined()
  })

  it('prunes a dead/unknown conversation id in place on read', () => {
    saveLastWorkspaceConversation('ws1', 'deadConv')
    // First read rejects + prunes it.
    expect(loadValidWorkspaceConversation('ws1', () => false)).toBeUndefined()
    // Even a subsequently-permissive validator sees nothing -- it's gone.
    expect(loadValidWorkspaceConversation('ws1', anyValid)).toBeUndefined()
  })
})
