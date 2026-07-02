// @vitest-environment jsdom
//
// The workspace is a MODE the user explicitly selects; selecting a conversation
// or a project must NEVER change it. These tests pin that contract (the exact
// bug that made switching feel "flaky": selection silently re-homed the
// workspace) plus the forward-only "workspace remembers its last conversation".
import { beforeEach, describe, expect, it } from 'vitest'
import { loadValidWorkspaceConversation, WORKSPACE_ALL } from '@/lib/workspace-membership'
import { useConversationsStore } from './use-conversations'

const alwaysValid = () => true

function seed() {
  localStorage.clear()
  useConversationsStore.setState({
    conversationsById: {},
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
  window.location.hash = ''
}

describe('workspace is a mode, not a consequence of selection', () => {
  beforeEach(seed)

  it('selecting a conversation does NOT change the active workspace', () => {
    const store = useConversationsStore.getState()
    store.updateControlPanelPrefs({ activeWorkspaceId: 'ws1' })
    store.selectConversation('convX')
    expect(useConversationsStore.getState().controlPanelPrefs.activeWorkspaceId).toBe('ws1')
  })

  it('selecting a project does NOT change the active workspace', () => {
    const store = useConversationsStore.getState()
    store.updateControlPanelPrefs({ activeWorkspaceId: 'ws1' })
    store.selectProject('claude:///some/project')
    expect(useConversationsStore.getState().controlPanelPrefs.activeWorkspaceId).toBe('ws1')
  })

  it('records the selected conversation as the active workspace’s last (forward-only)', () => {
    const store = useConversationsStore.getState()
    store.updateControlPanelPrefs({ activeWorkspaceId: 'ws1' })
    store.selectConversation('convX')
    expect(loadValidWorkspaceConversation('ws1', alwaysValid)).toBe('convX')
  })

  it('records against the All sentinel when no workspace is active', () => {
    const store = useConversationsStore.getState()
    store.updateControlPanelPrefs({ activeWorkspaceId: null })
    store.selectConversation('convY')
    expect(loadValidWorkspaceConversation(WORKSPACE_ALL, alwaysValid)).toBe('convY')
    expect(loadValidWorkspaceConversation('ws1', alwaysValid)).toBeUndefined()
  })
})
