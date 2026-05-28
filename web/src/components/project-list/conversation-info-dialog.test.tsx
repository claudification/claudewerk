import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { ConversationInfoButton, ConversationInfoDialog } from './conversation-info-dialog'

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-info-1',
    cwd: '/cwd',
    status: 'idle',
    startedAt: 1_000,
    lastActivity: 6_000,
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
    model: 'claude-sonnet-4-6',
    project: '/cwd',
    ...overrides,
  } as Conversation
}

function setStoreState(state: Record<string, unknown>) {
  useConversationsStore.setState({
    selectedConversationId: null,
    conversationsById: {},
    conversations: [],
    pendingPermissions: [],
    pendingProjectLinks: [],
    selectConversation: vi.fn(),
    ...state,
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

describe('ConversationInfoDialog', () => {
  beforeEach(() => {
    setStoreState({})
  })

  it('renders model and conversation id when open', () => {
    render(<ConversationInfoDialog conversation={makeConversation()} open onOpenChange={vi.fn()} />)
    expect(screen.getByText('Model')).toBeDefined()
    expect(screen.getAllByText(/conv-info-1/).length).toBeGreaterThan(0)
  })

  it('renders the LaunchParamsSection child for conversations with launch config', () => {
    const conv = makeConversation({
      launchConfig: { headless: true },
    } as unknown as Partial<Conversation>)
    render(<ConversationInfoDialog conversation={conv} open onOpenChange={vi.fn()} />)
    // LaunchParamsSection adds the "Launch" header when there are core params
    expect(screen.getByText('Launch')).toBeDefined()
    expect(screen.getByText('headless')).toBeDefined()
  })

  it('renders nothing in the DOM when closed', () => {
    render(<ConversationInfoDialog conversation={makeConversation()} open={false} onOpenChange={vi.fn()} />)
    expect(screen.queryByText('Conversation Info')).toBeNull()
  })

  it('renders spawn lineage when conversation has children in the store', () => {
    const parent = makeConversation({ id: 'p' })
    const child = makeConversation({ id: 'c', parentConversationId: 'p' })
    setStoreState({
      conversations: [parent, child],
      conversationsById: { p: parent, c: child },
    })
    render(<ConversationInfoDialog conversation={parent} open onOpenChange={vi.fn()} />)
    expect(screen.getByText(/Direct children/)).toBeDefined()
  })
})

describe('ConversationInfoButton', () => {
  beforeEach(() => {
    setStoreState({})
  })

  it('toggles the dialog open when the trigger is clicked', () => {
    render(<ConversationInfoButton conversation={makeConversation()} visible={true} />)
    // dialog closed by default
    expect(screen.queryByText('Conversation Info')).toBeNull()
    // click the info trigger (role=button)
    const trigger = screen.getByTitle('Conversation info')
    fireEvent.click(trigger)
    expect(screen.getByText('Conversation Info')).toBeDefined()
  })

  it('stops click propagation so the surrounding row does not navigate', () => {
    let outerClicked = false
    render(
      <div onClick={() => (outerClicked = true)}>
        <ConversationInfoButton conversation={makeConversation()} visible={true} />
      </div>,
    )
    const trigger = screen.getByTitle('Conversation info')
    fireEvent.click(trigger)
    expect(outerClicked).toBe(false)
  })
})
