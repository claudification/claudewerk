// @vitest-environment jsdom
//
// A workspace is a MODE the user selects. Selection stays neutral in ONE
// direction: it never drags you INTO a specific workspace (that would need the
// forbidden reverse lookup -- see workspace-membership.ts). But a genuine
// navigation to a target OUTSIDE the active workspace REVEALS it by dropping the
// filter to All, so you are never left staring at a sidebar that hides your own
// selection. Restore/auto-pick paths (workspace-switch, on-load defaults) opt out
// via NO_REVEAL_REASONS so switching INTO a workspace never bounces you back out
// (that self-clobber was the original "switching feels flaky" bug). These tests
// pin all of it.
import { beforeEach, describe, expect, it } from 'vitest'
import type { Conversation, ProjectOrder } from '@/lib/types'
import { loadValidWorkspaceConversation, WORKSPACE_ALL } from '@/lib/workspace-membership'
import { useConversationsStore } from './use-conversations'

const IN = 'claude:///proj/a'
const OUT = 'claude:///proj/b'
const WORKTREE_OF_IN = 'claude:///proj/a/.claude/worktrees/feature'
const alwaysValid = () => true

const ORDER: ProjectOrder = {
  tree: [],
  workspaces: [{ id: 'ws1', name: 'WS1' }],
  workspaceTrees: { ws1: [{ id: IN, type: 'project' }] },
}

const conv = (id: string, project: string): Conversation => ({ id, project }) as Conversation
const activeWs = () => useConversationsStore.getState().controlPanelPrefs.activeWorkspaceId

function seed(activeWorkspaceId: string | null) {
  localStorage.clear()
  window.location.hash = ''
  useConversationsStore.setState({
    conversationsById: {
      cIn: conv('cIn', IN),
      cOut: conv('cOut', OUT),
      cWt: conv('cWt', WORKTREE_OF_IN),
    },
    selectedConversationId: null,
    selectedProjectUri: null,
    selectedSubagentId: null,
    conversationMru: [],
    events: {},
    transcripts: {},
    showTerminal: false,
    terminalWrapperId: null,
    requestedTab: null,
    requestedTabSeq: 0,
  })
  useConversationsStore.getState().setProjectOrder(ORDER)
  useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId })
}

describe('navigating out of the active workspace reveals the target (drops to All)', () => {
  beforeEach(() => seed('ws1'))

  it('a genuine conversation navigation to an out-of-workspace conv drops to All', () => {
    useConversationsStore.getState().selectConversation('cOut', 'command-palette')
    expect(activeWs()).toBeNull()
  })

  it('a conversation navigation to an in-workspace conv stays put', () => {
    useConversationsStore.getState().selectConversation('cIn', 'command-palette')
    expect(activeWs()).toBe('ws1')
  })

  it('a worktree conversation whose PARENT is in the workspace stays put', () => {
    useConversationsStore.getState().selectConversation('cWt', 'hash-route')
    expect(activeWs()).toBe('ws1')
  })

  it('selecting an out-of-workspace project drops to All', () => {
    useConversationsStore.getState().selectProject(OUT)
    expect(activeWs()).toBeNull()
  })

  it('selecting an in-workspace project stays put', () => {
    useConversationsStore.getState().selectProject(IN)
    expect(activeWs()).toBe('ws1')
  })
})

describe('restore + auto-pick paths never bounce you out of the workspace', () => {
  beforeEach(() => seed('ws1'))

  it('workspace-switch restore of an out-of-tree conv does NOT clear the workspace', () => {
    // The self-clobber guard: switching INTO ws1 must not immediately reveal-away
    // just because its remembered conversation is out of tree.
    useConversationsStore.getState().selectConversation('cOut', 'workspace-switch')
    expect(activeWs()).toBe('ws1')
  })

  it('on-load default selection of an out-of-tree conv does NOT clear the workspace', () => {
    useConversationsStore.getState().selectConversation('cOut', 'default-conversation-last-viewed')
    expect(activeWs()).toBe('ws1')
  })

  it('from All, navigating never drags you INTO a workspace', () => {
    seed(null)
    useConversationsStore.getState().selectConversation('cIn', 'command-palette')
    expect(activeWs()).toBeNull()
  })
})

describe('workspace remembers its last conversation (forward-only)', () => {
  beforeEach(() => seed('ws1'))

  it('records an in-workspace selection as ws1’s last', () => {
    useConversationsStore.getState().selectConversation('cIn', 'command-palette')
    expect(loadValidWorkspaceConversation('ws1', alwaysValid)).toBe('cIn')
  })

  it('an out-of-workspace nav reveals to All first, so it records against All, not ws1', () => {
    useConversationsStore.getState().selectConversation('cOut', 'command-palette')
    expect(loadValidWorkspaceConversation(WORKSPACE_ALL, alwaysValid)).toBe('cOut')
    expect(loadValidWorkspaceConversation('ws1', alwaysValid)).toBeUndefined()
  })

  it('records against the All sentinel when no workspace is active', () => {
    seed(null)
    useConversationsStore.getState().selectConversation('cIn', 'command-palette')
    expect(loadValidWorkspaceConversation(WORKSPACE_ALL, alwaysValid)).toBe('cIn')
  })
})
