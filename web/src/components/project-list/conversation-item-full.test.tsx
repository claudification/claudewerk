import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { ConversationItemFull } from './conversation-item-full'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const selectConversation = vi.fn()

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-full-1',
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

describe('ConversationItemFull', () => {
  beforeEach(() => {
    selectConversation.mockReset()
    setStoreState({})
  })

  it('renders the project display name from the conversation cwd', () => {
    render(<ConversationItemFull conversation={makeConversation()} />)
    // projectDisplayName(projectPath('/home/me/proj')) emits the leaf segment
    expect(screen.getByText('proj')).toBeDefined()
  })

  it('calls selectConversation when the card is clicked', () => {
    render(<ConversationItemFull conversation={makeConversation({ id: 'click-me' })} />)
    const card = screen.getByText('proj').closest('[role="button"]')
    expect(card).toBeTruthy()
    if (!card) throw new Error('card not found')
    fireEvent.click(card)
    expect(selectConversation).toHaveBeenCalledWith('click-me', 'click')
  })

  it('shows the PLAN badge when the conversation is in plan mode', () => {
    render(<ConversationItemFull conversation={makeConversation({ planMode: true })} />)
    expect(screen.getByText(/^plan$/i)).toBeDefined()
  })

  it('shows the ERROR badge when the conversation has a last error', () => {
    render(
      <ConversationItemFull
        conversation={makeConversation({
          lastError: { errorMessage: 'boom', errorType: 'api' },
        } as Partial<Conversation>)}
      />,
    )
    expect(screen.getByText(/^error$/i)).toBeDefined()
  })
})
