import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { RunCard } from './run-card'
import { RunScopeAffordance } from './run-scope-affordance'

function makeConversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv-run-1',
    agentName: 'blazing-pretzel',
    status: 'active',
    startedAt: 1_000,
    lastActivity: Date.now() - 4 * 60_000,
    eventCount: 0,
    activeSubagentCount: 2,
    totalSubagentCount: 2,
    subagents: [],
    taskCount: 3,
    pendingTaskCount: 2,
    activeTasks: [],
    pendingTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    teammates: [],
    model: 'claude-opus-4-6',
    project: 'claude:///Users/jonas/projects/remote-claude',
    commitCount: 7,
    tokenUsage: { input: 100_000, cacheCreation: 0, cacheRead: 0, output: 1_000 },
    contextWindow: 200_000,
    stats: {
      totalInputTokens: 100_000,
      totalOutputTokens: 1_000,
      totalCacheCreation: 0,
      totalCacheRead: 0,
      turnCount: 4,
      toolCallCount: 9,
      compactionCount: 0,
      totalCostUsd: 4.12,
      linesAdded: 0,
      linesRemoved: 0,
      totalApiDurationMs: 0,
    },
    ...overrides,
  } as Conversation
}

function setStoreState(state: Record<string, unknown> = {}) {
  useConversationsStore.setState({
    selectedConversationId: null,
    conversationsById: {},
    conversations: [],
    projectSettings: {},
    pendingPermissions: [],
    pendingProjectLinks: [],
    selectProject: vi.fn(),
    selectConversation: vi.fn(),
    ...state,
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('RunCard', () => {
  beforeEach(() => setStoreState())

  it('renders every THIS RUN number off the summary', () => {
    render(<RunCard conversation={makeConversation()} />)
    expect(screen.getByText('this run')).toBeDefined()
    expect(screen.getByText('7')).toBeDefined() // commits
    expect(screen.getByText('2 pending')).toBeDefined() // tasks
    expect(screen.getByText('$4.12')).toBeDefined() // cost
    expect(screen.getByText('50%')).toBeDefined() // context (100k of 200k)
  })

  it('counts spawned children from the local list when the summary omits the count', () => {
    const parent = makeConversation()
    const child = makeConversation({ id: 'kid', parentConversationId: parent.id })
    setStoreState({ conversationsById: { [parent.id]: parent, kid: child } })
    render(<RunCard conversation={parent} />)
    const spawned = screen.getByText('spawned').parentElement as HTMLElement
    expect(spawned.textContent).toContain('1')
  })

  it('touches no network -- the RUN card needs no new data', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    render(<RunCard conversation={makeConversation()} />)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows NO board/Kanban number -- a board belongs to the PLACE, not the run', () => {
    const { container } = render(<RunCard conversation={makeConversation()} />)
    const text = container.textContent ?? ''
    expect(text).not.toMatch(/board|in-progress|review|open \d/i)
  })

  it('offers the step-up seam to the project and nothing in reverse', () => {
    const selectProject = vi.fn()
    setStoreState({ selectProject })
    render(<RunCard conversation={makeConversation()} />)
    fireEvent.click(screen.getByText(/in remote-claude/))
    expect(selectProject).toHaveBeenCalledWith('claude:///Users/jonas/projects/remote-claude')
  })

  it('renders the worktree line only when the working path diverges from the project', () => {
    const { rerender } = render(
      <RunCard conversation={makeConversation({ currentPath: '/Users/jonas/projects/remote-claude' })} />,
    )
    expect(screen.queryByText('worktree')).toBeNull()
    rerender(
      <RunCard
        conversation={makeConversation({ currentPath: '/Users/jonas/projects/remote-claude/.claude/worktrees/x' })}
      />,
    )
    expect(screen.getByText('worktree')).toBeDefined()
  })
})

describe('RunScopeAffordance', () => {
  beforeEach(() => setStoreState())

  it('opens the full info dialog on click (pointer path) and swallows the row click', () => {
    let rowClicked = false
    render(
      // biome-ignore lint/a11y/useKeyWithClickEvents: stand-in for the clickable row
      <div onClick={() => (rowClicked = true)}>
        <RunScopeAffordance conversation={makeConversation()} visible />
      </div>,
    )
    expect(screen.queryByText('Conversation Info')).toBeNull()
    fireEvent.click(screen.getByTitle('Conversation info'))
    expect(screen.getByText('Conversation Info')).toBeDefined()
    expect(rowClicked).toBe(false)
  })
})
