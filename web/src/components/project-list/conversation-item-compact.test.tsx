import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { ConversationItemCompact } from './conversation-item-compact'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const selectConversation = vi.fn()

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-compact-1',
    cwd: '/home/me/proj',
    status: 'idle',
    startedAt: 0,
    lastActivity: 0,
    eventCount: 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    project: '/home/me/proj',
    backend: 'claude',
    model: 'claude-sonnet-4-6',
    title: 'My compact convo',
    ...overrides,
  } as Conversation
}

function setStoreState(state: Record<string, unknown>) {
  useConversationsStore.setState({
    selectedConversationId: null,
    selectedSubagentId: null,
    selectConversation,
    openTab: vi.fn(),
    conversations: [],
    conversationsById: {},
    projectSettings: {},
    pendingPermissions: [],
    pendingProjectLinks: [],
    controlPanelPrefs: { showCostInList: false, showContextInList: false, showRecapDescInList: false },
    renamingConversationId: null,
    editingDescriptionConversationId: null,
    permissions: {
      canAdmin: false,
      canChat: true,
      canReadTerminal: true,
      canReadFiles: true,
      canFiles: true,
      canSpawn: true,
    },
    currentBatchId: null,
    selectedForBatch: new Set(),
    ...state,
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

describe('ConversationItemCompact', () => {
  beforeEach(() => {
    selectConversation.mockReset()
    setStoreState({})
  })

  it('renders the conversation title (clipped to 24 chars)', () => {
    render(<ConversationItemCompact conversation={makeConversation({ title: 'short title' })} />)
    expect(screen.getByText('short title')).toBeDefined()
  })

  it('calls selectConversation when the card is clicked', () => {
    render(<ConversationItemCompact conversation={makeConversation({ id: 'click-me-compact' })} />)
    const card = screen.getByText('My compact convo').closest('[role="button"]')
    expect(card).toBeTruthy()
    if (!card) throw new Error('card not found')
    fireEvent.click(card)
    expect(selectConversation).toHaveBeenCalledWith('click-me-compact', 'click')
  })

  it('shows the NATIVE chip for claude-daemon transport conversations', () => {
    render(
      <ConversationItemCompact
        conversation={makeConversation({ transport: 'claude-daemon' } as Partial<Conversation>)}
      />,
    )
    expect(screen.getByText(/^NATIVE$/)).toBeDefined()
  })

  it('shows the ERROR chip when conversation has a lastError', () => {
    render(
      <ConversationItemCompact
        conversation={makeConversation({
          lastError: { errorMessage: 'boom', errorType: 'api' },
        } as Partial<Conversation>)}
      />,
    )
    expect(screen.getByText(/^ERROR$/)).toBeDefined()
  })
})
