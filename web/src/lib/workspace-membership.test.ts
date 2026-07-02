// @vitest-environment jsdom
import { beforeEach, describe, expect, it } from 'vitest'
import type { ProjectOrder } from '@/lib/types'
import {
  isProjectInWorkspace,
  loadValidWorkspaceConversation,
  saveLastWorkspaceConversation,
  WORKSPACE_ALL,
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
