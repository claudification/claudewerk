/**
 * A1 as it RENDERS: the two tiers that never merge, the clock that counts up on
 * its own, the number keys, and a click that reaches the real answer path.
 *
 * The conversations store is faked at the module boundary rather than driven
 * through the websocket -- the pane's contract is "the store action I call is
 * the one the transcript calls", and a spy in that slot is what proves it.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Conversation } from '@/lib/types'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import AttentionPane from './panes/a1-attention'

const NOW = 1_700_000_000_000

const fake = vi.hoisted(() => {
  const state = {
    pendingPermissions: [] as unknown[],
    pendingProjectLinks: [] as unknown[],
    pendingAskQuestions: [] as unknown[],
    pendingDialogs: {} as Record<string, unknown>,
    projectSettings: {} as Record<string, unknown>,
    conversations: [] as unknown[],
    respondToPermission: vi.fn(),
    allowPermissionAlways: vi.fn(),
    respondToProjectLink: vi.fn(),
    respondToAskQuestion: vi.fn(),
    submitDialog: vi.fn(),
    respondToSpawnApproval: vi.fn(),
  }
  return { state }
})

vi.mock('@/hooks/use-conversations', () => {
  const store = (sel: (s: typeof fake.state) => unknown) => sel(fake.state)
  store.getState = () => fake.state
  return { useConversationsStore: store, useConversations: () => fake.state.conversations }
})

function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    project: 'claude:///Users/j/remote-claude',
    status: 'active',
    title: 'wall pane attention',
    lastActivity: NOW - 60_000,
    ...over,
  } as unknown as Conversation
}

const permission = (over = {}) => ({
  conversationId: 'conv_1',
  requestId: 'req_1',
  toolName: 'Bash',
  description: 'run a command',
  inputPreview: '',
  timestamp: NOW - 120_000,
  ...over,
})

const needy = (id: string, project: string) =>
  conv({
    id,
    project,
    title: `soft ${id}`,
    liveStatus: { state: 'needs_you', seq: 1, updatedAt: NOW - 30_000 },
  } as Partial<Conversation>)

/** The hard row carries the permission; the soft one only says it wants you. */
function twoTiers() {
  fake.state.pendingPermissions = [permission()]
  fake.state.conversations = [conv(), needy('conv_2', 'claude:///Users/j/gate-meet')]
}

function list(tier: 'hard' | 'soft'): HTMLElement | null {
  return document.querySelector(`ul.wall-att-list[data-tier="${tier}"]`)
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
  fake.state.pendingPermissions = []
  fake.state.pendingProjectLinks = []
  fake.state.pendingAskQuestions = []
  fake.state.pendingDialogs = {}
  fake.state.conversations = []
  useWallFilterStore.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.clearAllMocks()
})

describe('the A1 attention pane', () => {
  it('says the sentence Jonas wants to see when nobody is waiting', () => {
    render(<AttentionPane />)
    expect(screen.getByText('nobody is waiting on you')).toBeTruthy()
    expect(screen.getByText('0/0 waiting')).toBeTruthy()
  })

  it('NEVER collapses hard and soft into one list', () => {
    twoTiers()
    render(<AttentionPane />)

    expect(list('hard')?.querySelectorAll('li')).toHaveLength(1)
    expect(list('soft')?.querySelectorAll('li')).toHaveLength(1)
    // The hard row is in the hard list and nowhere else.
    expect(list('soft')?.textContent).not.toContain('permission: Bash')
    expect(list('hard')?.textContent).toContain('permission: Bash')
    expect(screen.getByText(/HARD/)).toBeTruthy()
    expect(screen.getByText(/SOFT/)).toBeTruthy()
  })

  it('counts the wait UP without new data', () => {
    fake.state.pendingPermissions = [permission({ timestamp: NOW - 60_000 })]
    fake.state.conversations = [conv()]
    render(<AttentionPane />)
    expect(screen.getByTitle(/waiting since/).textContent).toBe('1m')

    act(() => {
      vi.advanceTimersByTime(120_000)
    })
    expect(screen.getByTitle(/waiting since/).textContent).toBe('3m')
  })

  it('ALLOW clicked here reaches the conversation`s own answer path', () => {
    fake.state.pendingPermissions = [permission()]
    fake.state.conversations = [conv()]
    render(<AttentionPane />)

    fireEvent.click(screen.getByText('ALLOW'))
    expect(fake.state.respondToPermission).toHaveBeenCalledWith('conv_1', 'req_1', 'allow')
  })

  it('the number key fires the FIRST entry`s primary action -- and only that one', () => {
    twoTiers()
    render(<AttentionPane />)

    fireEvent.keyDown(window, { key: '1' })
    expect(fake.state.respondToPermission).toHaveBeenCalledWith('conv_1', 'req_1', 'allow')

    // Entry 2 is a soft report with no answer path: the key must do nothing at
    // all rather than fall through to whatever is answerable further down.
    fireEvent.keyDown(window, { key: '2' })
    expect(fake.state.respondToPermission).toHaveBeenCalledTimes(1)
  })

  it('does not answer anything while you are typing in the filter box', () => {
    fake.state.pendingPermissions = [permission()]
    fake.state.conversations = [conv()]
    render(
      <>
        <input aria-label="filter" />
        <AttentionPane />
      </>,
    )

    fireEvent.keyDown(screen.getByLabelText('filter'), { key: '1' })
    expect(fake.state.respondToPermission).not.toHaveBeenCalled()
  })

  it('renders {matched}/{total} and stays FULL for an axis it does not declare', () => {
    twoTiers()
    render(<AttentionPane />)
    expect(screen.getByText('2/2 waiting')).toBeTruthy()

    // `%80` is context pressure -- a pending question has none, so the pane
    // must not blank.
    act(() => useWallFilterStore.getState().setRaw('%80'))
    expect(screen.getByText('2/2 waiting')).toBeTruthy()

    // `!!!` is the blocked band, which IS an axis it declares.
    act(() => useWallFilterStore.getState().setRaw('!!!'))
    expect(screen.getByText('1/2 waiting')).toBeTruthy()
    expect(list('soft')).toBeNull()
  })

  it('the project chip filters the wall through the store`s own action', () => {
    twoTiers()
    render(<AttentionPane />)

    fireEvent.click(screen.getByText('gate-meet'))
    expect(useWallFilterStore.getState().raw).toContain('gate-meet')
  })
})
