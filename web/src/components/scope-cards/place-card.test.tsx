import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { applyProjectCommitStats } from '@/hooks/use-project-commit-stats'
import { applyProjectIntegration } from '@/hooks/use-project-integration'
import type { Conversation } from '@/lib/types'
import { PlaceCard } from './place-card'
import { RunCard } from './run-card'

let projectSeq = 0
const nextProject = () => `claude://default/Users/x/place-${++projectSeq}`

let sent: Array<Record<string, unknown>> = []

function conv(id: string, project: string, status: Conversation['status']): Conversation {
  return {
    id,
    project,
    status,
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
  } as unknown as Conversation
}

function installFakeWire(conversations: Conversation[] = []) {
  sent = []
  const byId: Record<string, Conversation> = {}
  for (const c of conversations) byId[c.id] = c
  useConversationsStore.setState({
    conversations,
    conversationsById: byId,
    projectSettings: {},
    selectProject: vi.fn(),
    sendWsMessage: (msg: Record<string, unknown>) => {
      sent.push(msg)
      if (msg.type !== 'project_board_request' || msg.op !== 'manifest') return
      queueMicrotask(() =>
        useConversationsStore.getState().projectHandler?.({
          type: 'project_board_result',
          requestId: msg.requestId,
          manifest: [
            { slug: 'a', status: 'open', mtime: 1 },
            { slug: 'b', status: 'open', mtime: 2 },
            { slug: 'c', status: 'in-progress', mtime: 3 },
          ],
        }),
      )
    },
    ws: null,
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('PlaceCard', () => {
  beforeEach(() => installFakeWire())

  it('renders each section: board, conversations, commits, integration', async () => {
    const project = nextProject()
    installFakeWire([
      conv('a', project, 'active'),
      conv('b', project, 'idle'),
      conv('c', project, 'ended'),
      conv('d', 'claude://default/Users/x/elsewhere', 'active'),
    ])
    applyProjectCommitStats(project, { total: 142, agent: 131, human: 11, today: 9, lastCommittedAt: Date.now() })
    applyProjectIntegration(project, {
      unpushed: 2,
      stalled: 1,
      dirty: 0,
      conflicts: 0,
      branches: 5,
      scannedAt: Date.now() - 12 * 60_000,
      fetchedAt: null,
    })
    render(<PlaceCard project={project} />)

    await waitFor(() => expect(screen.getByText('board')).toBeDefined())
    expect(screen.getByText('conversations')).toBeDefined()
    expect(screen.getByText('commits')).toBeDefined()
    expect(screen.getByText('integration')).toBeDefined()
    // Conversations are counted for THIS project only.
    const active = screen.getByText('active').parentElement as HTMLElement
    expect(active.textContent).toContain('1')
    expect(screen.getByText(/142 total/)).toBeDefined()
    expect(screen.getByText(/2 unpushed · 1 stalled/)).toBeDefined()
    expect(screen.getByText(/scanned 12m ago/)).toBeDefined()
  })

  it('ARMS NO SENTINEL WATCH and triggers NO SOTU scan when hovered', async () => {
    const project = nextProject()
    render(<PlaceCard project={project} />)
    await waitFor(() => expect(sent.some(m => m.type === 'project_board_request')).toBe(true))
    expect(sent.some(m => m.type === 'project_subscribe')).toBe(false)
    // sotu_view would lazily kick off a PAID distill; the card asks for the
    // stored snapshot instead.
    expect(sent.some(m => m.type === 'sotu_view')).toBe(false)
    expect(sent.some(m => m.type === 'sotu_fleet')).toBe(false)
  })

  it('says "no git scan yet" rather than implying all-clean', async () => {
    const project = nextProject()
    applyProjectIntegration(project, {
      unpushed: 0,
      stalled: 0,
      dirty: 0,
      conflicts: 0,
      branches: 0,
      scannedAt: null,
      fetchedAt: null,
    })
    render(<PlaceCard project={project} />)
    await waitFor(() => expect(screen.getByText('no git scan yet')).toBeDefined())
  })

  it('opens the board and the project from its footer seams', async () => {
    const project = nextProject()
    const selectProject = vi.fn()
    useConversationsStore.setState({ selectProject } as unknown as ReturnType<typeof useConversationsStore.getState>)
    render(<PlaceCard project={project} />)
    fireEvent.click(screen.getByText(/^project/))
    expect(selectProject).toHaveBeenCalledWith(project)
  })
})

// ─── The rule the whole design turns on ───────────────────────────────
//
// A conversation is a RUN, a project is a PLACE. Every number belongs to exactly
// one card. A board count on a run is the category error that started this.

describe('scope separation', () => {
  beforeEach(() => installFakeWire())

  it('keeps place-numbers off the RUN card and run-numbers off the PLACE card', async () => {
    const project = nextProject()
    applyProjectCommitStats(project, { total: 142, agent: 131, human: 11, today: 9, lastCommittedAt: null })
    const conversation = {
      ...conv('run-1', project, 'active'),
      commitCount: 7,
      stats: { totalCostUsd: 4.12 },
      model: 'claude-opus-4-6',
    } as unknown as Conversation
    installFakeWire([conversation])
    applyProjectCommitStats(project, { total: 142, agent: 131, human: 11, today: 9, lastCommittedAt: null })

    const run = render(<RunCard conversation={conversation} />)
    const runText = run.container.textContent ?? ''
    // The run shows ITS commits (7), never the project's history (142), and no
    // board number at all.
    expect(runText).toContain('7')
    expect(runText).not.toContain('142')
    expect(runText.toLowerCase()).not.toContain('board')
    cleanup()

    const place = render(<PlaceCard project={project} />)
    await waitFor(() => expect(place.container.textContent).toContain('142 total'))
    const placeText = place.container.textContent ?? ''
    // The place shows the whole history, never one run's cost or context.
    expect(placeText).not.toContain('$4.12')
    expect(placeText.toLowerCase()).not.toContain('context')
    expect(placeText.toLowerCase()).not.toContain('subagent')
  })
})
