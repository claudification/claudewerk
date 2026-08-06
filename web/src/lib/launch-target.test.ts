// @vitest-environment jsdom
//
// The bug this pins: LAUNCH with a workspace selected but no conversation had
// no idea which project it was for -- the `l` chord fell back to `~` and the
// mobile FAB to `.`, silently, even when the workspace held exactly one project.
import { describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { launchTargetNeedsWarning, resolveLaunchTarget, resolveLaunchTargetFromStore } from '@/lib/launch-target'
import type { Conversation, ProjectOrder } from '@/lib/types'
import { projectsInWorkspace } from '@/lib/workspace-membership'

const ALPHA = 'claude:///Users/j/alpha'
const BETA = 'claude:///Users/j/beta'
const GAMMA = 'claude:///Users/j/gamma'

const ONE_PROJECT: ProjectOrder = {
  tree: [],
  workspaces: [{ id: 'ws1', name: 'Solo' }],
  workspaceTrees: { ws1: [{ id: ALPHA, type: 'project' }] },
}

const TWO_PROJECTS: ProjectOrder = {
  tree: [],
  workspaces: [{ id: 'ws2', name: 'Pair' }],
  workspaceTrees: {
    ws2: [
      { id: ALPHA, type: 'project' },
      { id: BETA, type: 'project' },
    ],
  },
}

const NESTED_ONE: ProjectOrder = {
  tree: [],
  workspaceTrees: {
    ws3: [
      {
        id: 'g1',
        type: 'group',
        name: 'Group',
        children: [{ id: 'g2', type: 'group', name: 'Inner', children: [{ id: GAMMA, type: 'project' }] }],
      },
    ],
  },
}

describe('projectsInWorkspace', () => {
  it('lists projects in a flat workspace tree', () => {
    expect(projectsInWorkspace(TWO_PROJECTS, 'ws2')).toEqual([ALPHA, BETA])
  })

  it('walks nested groups, not just the first level', () => {
    expect(projectsInWorkspace(NESTED_ONE, 'ws3')).toEqual([GAMMA])
  })

  it('returns [] for an unknown or empty workspace', () => {
    expect(projectsInWorkspace(ONE_PROJECT, 'nope')).toEqual([])
  })
})

describe('resolveLaunchTarget', () => {
  it('prefers the selected conversation project', () => {
    const t = resolveLaunchTarget({
      conversationProjectUri: BETA,
      selectedProjectUri: ALPHA,
      activeWorkspaceId: 'ws1',
      projectOrder: ONE_PROJECT,
      defaultConversationCwd: '/tmp/default',
    })
    expect(t).toEqual({ path: '/Users/j/beta', projectUri: BETA, source: 'conversation' })
  })

  it('falls back to the explicitly selected project', () => {
    const t = resolveLaunchTarget({
      selectedProjectUri: ALPHA,
      activeWorkspaceId: 'ws1',
      projectOrder: ONE_PROJECT,
    })
    expect(t).toEqual({ path: '/Users/j/alpha', projectUri: ALPHA, source: 'project' })
  })

  it('assumes the sole project of the active workspace when nothing is selected', () => {
    const t = resolveLaunchTarget({ activeWorkspaceId: 'ws1', projectOrder: ONE_PROJECT })
    expect(t).toEqual({ path: '/Users/j/alpha', projectUri: ALPHA, source: 'workspace-sole' })
  })

  it('finds the sole project inside nested groups', () => {
    const t = resolveLaunchTarget({ activeWorkspaceId: 'ws3', projectOrder: NESTED_ONE })
    expect(t.source).toBe('workspace-sole')
    expect(t.projectUri).toBe(GAMMA)
  })

  it('never guesses when the workspace holds more than one project', () => {
    const t = resolveLaunchTarget({ activeWorkspaceId: 'ws2', projectOrder: TWO_PROJECTS })
    expect(t.source).toBe('none')
    expect(t.projectUri).toBeUndefined()
  })

  it('does not infer anything in the All view (no active workspace)', () => {
    const t = resolveLaunchTarget({ activeWorkspaceId: null, projectOrder: ONE_PROJECT })
    expect(t.source).toBe('none')
  })

  it('uses the configured default cwd before giving up', () => {
    const t = resolveLaunchTarget({
      activeWorkspaceId: 'ws2',
      projectOrder: TWO_PROJECTS,
      defaultConversationCwd: '/tmp/d',
    })
    expect(t).toEqual({ path: '/tmp/d', source: 'default-cwd' })
  })

  it('ignores a whitespace-only default cwd', () => {
    expect(resolveLaunchTarget({ defaultConversationCwd: '   ' })).toEqual({ path: '~', source: 'none' })
  })

  it('falls all the way through to ~ with an empty input', () => {
    expect(resolveLaunchTarget({})).toEqual({ path: '~', source: 'none' })
  })
})

describe('resolveLaunchTargetFromStore', () => {
  function seed(overrides: Partial<Parameters<typeof useConversationsStore.setState>[0]> = {}) {
    localStorage.clear()
    useConversationsStore.setState({
      conversationsById: { c1: { id: 'c1', project: BETA } as Conversation },
      selectedConversationId: null,
      selectedProjectUri: null,
      ...overrides,
    })
    useConversationsStore.getState().setProjectOrder(ONE_PROJECT)
    useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId: null, defaultConversationCwd: '' })
  }

  it('picks the workspace sole project when nothing is selected', () => {
    seed()
    useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId: 'ws1' })
    expect(resolveLaunchTargetFromStore()).toEqual({
      path: '/Users/j/alpha',
      projectUri: ALPHA,
      source: 'workspace-sole',
    })
  })

  it('reports `none` in the All view with nothing selected', () => {
    seed()
    expect(resolveLaunchTargetFromStore().source).toBe('none')
  })

  it('still prefers the selected conversation over the workspace', () => {
    seed({ selectedConversationId: 'c1' })
    useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId: 'ws1' })
    expect(resolveLaunchTargetFromStore()).toEqual({ path: '/Users/j/beta', projectUri: BETA, source: 'conversation' })
  })
})

describe('launchTargetNeedsWarning', () => {
  it('warns only when no project was resolved', () => {
    expect(launchTargetNeedsWarning('none')).toBe(true)
    expect(launchTargetNeedsWarning('default-cwd')).toBe(true)
    expect(launchTargetNeedsWarning('conversation')).toBe(false)
    expect(launchTargetNeedsWarning('project')).toBe(false)
    expect(launchTargetNeedsWarning('workspace-sole')).toBe(false)
  })
})
