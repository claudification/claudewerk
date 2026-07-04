// @vitest-environment jsdom
//
// The command palette searches across ALL workspaces, but the sidebar is scoped
// to the active one -- so jumping to an out-of-workspace hit used to leave you
// staring at a sidebar that hides it, forcing a manual switch to All. These
// tests pin the fix: an explicit palette pick of a target NOT in the active
// workspace drops the filter to All (null) so the target is visible; a pick that
// IS in the active workspace leaves the workspace untouched. The store's
// selectConversation/selectProject stay workspace-neutral (see workspace-mode.test.ts).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation, ProjectOrder } from '@/lib/types'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversationFromPalette, selectProjectFromPalette } from './palette-navigate'

const IN = 'claude:///proj/a'
const OUT = 'claude:///proj/b'
const WORKTREE_OF_IN = 'claude:///proj/a/.claude/worktrees/feature'

const ORDER: ProjectOrder = {
  tree: [],
  workspaces: [{ id: 'ws1', name: 'WS1' }],
  workspaceTrees: { ws1: [{ id: IN, type: 'project' }] },
}

function seed(activeWorkspaceId: string | null) {
  localStorage.clear()
  window.location.hash = ''
  useConversationsStore.setState({
    conversationsById: {},
    selectedConversationId: null,
    selectedProjectUri: null,
    selectedSubagentId: null,
    conversationMru: [],
  })
  useConversationsStore.getState().setProjectOrder(ORDER)
  useConversationsStore.getState().updateControlPanelPrefs({ activeWorkspaceId })
}

const activeWs = () => useConversationsStore.getState().controlPanelPrefs.activeWorkspaceId
const conv = (project: string): Conversation => ({ id: 'c1', project }) as Conversation

describe('palette navigation reveals out-of-workspace targets', () => {
  beforeEach(() => seed('ws1'))

  it('picking a project NOT in the active workspace drops the filter to All', () => {
    selectProjectFromPalette(OUT)
    expect(activeWs()).toBeNull()
  })

  it('picking a project IN the active workspace leaves the workspace untouched', () => {
    selectProjectFromPalette(IN)
    expect(activeWs()).toBe('ws1')
  })

  it('picking a conversation of an out-of-workspace project drops to All and still navigates', () => {
    const onSelect = vi.fn()
    selectConversationFromPalette(conv(OUT), onSelect)
    expect(activeWs()).toBeNull()
    expect(onSelect).toHaveBeenCalledWith('c1')
  })

  it('picking a conversation of an in-workspace project stays put', () => {
    selectConversationFromPalette(conv(IN), vi.fn())
    expect(activeWs()).toBe('ws1')
  })

  it('a worktree conversation whose PARENT is in the workspace stays put', () => {
    selectConversationFromPalette(conv(WORKTREE_OF_IN), vi.fn())
    expect(activeWs()).toBe('ws1')
  })

  it('is a no-op on the All view (already null)', () => {
    seed(null)
    const onSelect = vi.fn()
    selectConversationFromPalette(conv(OUT), onSelect)
    expect(activeWs()).toBeNull()
    expect(onSelect).toHaveBeenCalledWith('c1')
  })
})
