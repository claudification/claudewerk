// @vitest-environment jsdom
//
// Quick-switch (ctrl+Tab / FAB double-tap) is a BOUNCE: it must land you exactly
// where you were, workspace included, and bouncing twice must return you to the
// start. The bug this pins: with only conversation ids in the MRU, bouncing to a
// conversation living in another workspace fell through to the generic reveal and
// dumped you in the All view -- so the workspace of the switch was lost and the
// round-trip was asymmetric.
import { beforeEach, describe, expect, it } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation, ProjectOrder } from '@/lib/types'
import { loadValidWorkspaceConversation, WORKSPACE_ALL } from '@/lib/workspace-membership'
import { quickSwitchConversation, switchWorkspace } from '@/lib/workspace-switch'

const P1 = 'claude:///proj/one'
const P2 = 'claude:///proj/two'
const alwaysValid = () => true

const ORDER: ProjectOrder = {
  tree: [],
  workspaces: [
    { id: 'ws1', name: 'WS1' },
    { id: 'ws2', name: 'WS2' },
  ],
  workspaceTrees: { ws1: [{ id: P1, type: 'project' }], ws2: [{ id: P2, type: 'project' }] },
}

const conv = (id: string, project: string): Conversation => ({ id, project }) as Conversation
const store = () => useConversationsStore.getState()
const activeWs = () => store().controlPanelPrefs.activeWorkspaceId
const selected = () => store().selectedConversationId

function seed() {
  localStorage.clear()
  window.location.hash = ''
  useConversationsStore.setState({
    conversationsById: { c1: conv('c1', P1), c2: conv('c2', P2) },
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
  store().setProjectOrder(ORDER)
  store().updateControlPanelPrefs({ activeWorkspaceId: null })
}

// Land on c1 in ws1, then on c2 in ws2 -- the exact state a user is in right
// before hitting ctrl+Tab across two workspaces.
function seedTwoWorkspaceVisits() {
  seed()
  switchWorkspace('ws1')
  store().selectConversation('c1', 'command-palette')
  switchWorkspace('ws2')
  store().selectConversation('c2', 'command-palette')
}

describe('quick switch across workspaces', () => {
  beforeEach(seedTwoWorkspaceVisits)

  it('restores the workspace the target was last viewed in', () => {
    expect(activeWs()).toBe('ws2')
    quickSwitchConversation()
    expect(selected()).toBe('c1')
    expect(activeWs()).toBe('ws1')
  })

  it('is symmetric -- bouncing twice returns to the starting workspace + conversation', () => {
    quickSwitchConversation()
    quickSwitchConversation()
    expect(selected()).toBe('c2')
    expect(activeWs()).toBe('ws2')
  })

  it('records the conversation it leaves behind for the workspace it leaves', () => {
    quickSwitchConversation()
    expect(loadValidWorkspaceConversation('ws2', alwaysValid)).toBe('c2')
    expect(loadValidWorkspaceConversation('ws1', alwaysValid)).toBe('c1')
  })

  it('does not drop to the All view', () => {
    quickSwitchConversation()
    expect(activeWs()).not.toBeNull()
    expect(loadValidWorkspaceConversation(WORKSPACE_ALL, alwaysValid)).toBeUndefined()
  })
})

describe('quick switch without a usable visit workspace', () => {
  it('falls back to plain navigation (reveal drops to All) when the visit workspace is gone', () => {
    seedTwoWorkspaceVisits()
    // A visit recorded against a workspace that has since been deleted.
    useConversationsStore.setState({
      conversationMru: useConversationsStore
        .getState()
        .conversationMru.map(e => (e.id === 'c1' ? { ...e, workspaceId: 'ws-gone' } : e)),
    })
    quickSwitchConversation()
    expect(selected()).toBe('c1')
    expect(activeWs()).toBeNull()
  })

  it('stays put when both conversations were viewed in the same workspace', () => {
    seed()
    switchWorkspace('ws1')
    store().selectConversation('c1', 'command-palette')
    store().selectConversation('c2', 'workspace-switch') // out-of-tree, no reveal
    quickSwitchConversation()
    expect(selected()).toBe('c1')
    expect(activeWs()).toBe('ws1')
  })

  it('is a no-op when there is no previous conversation', () => {
    seed()
    store().selectConversation('c1', 'command-palette')
    quickSwitchConversation()
    expect(selected()).toBe('c1')
  })
})
