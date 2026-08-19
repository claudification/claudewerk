/**
 * Regression: right-clicking a chat BUBBLE has to open the fork menu.
 *
 * The first cut shipped dead. `ContextMenu.Trigger asChild` clones its child and
 * hands it `onContextMenu` plus a ref; ChatBubble destructured its seven named
 * props and spread nothing onto its DOM, so both were silently dropped and only
 * the bordered-group path (which wraps a raw div) responded. The seed-builder
 * unit tests all passed, because none of them rendered anything.
 *
 * These tests drive the real components through a real right-click.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

const openForkDialog = vi.fn()
vi.mock('../fork-dialog-trigger', () => ({ openForkDialog: (...a: unknown[]) => openForkDialog(...a) }))
vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ selectedConversationId: 'conv-under-test' }) },
}))

const { MemoizedGroupView } = await import('./group-view')

import type { TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'

const SETTINGS: TranscriptSettings = {
  expandAll: false,
  userLabel: 'USER',
  agentLabel: 'CLAUDE',
  userColor: '',
  agentColor: '',
  userSize: '',
  agentSize: '',
  chatBubbles: true,
  bubbleColor: 'blue',
}

function group(type: 'user' | 'assistant', text: string): DisplayGroup {
  return {
    type,
    timestamp: '2026-08-19T10:00:00.000Z',
    entries: [
      {
        type,
        uuid: 'cc-uuid-boundary',
        timestamp: '2026-08-19T10:00:00.000Z',
        message:
          type === 'user' ? { role: 'user', content: text } : { role: 'assistant', content: [{ type: 'text', text }] },
      },
    ],
  } as unknown as DisplayGroup
}

function renderGroup(g: DisplayGroup, settings = SETTINGS) {
  return render(<MemoizedGroupView group={g} getResult={() => undefined} settings={settings} />)
}

afterEach(() => {
  cleanup()
  openForkDialog.mockClear()
})

describe('right-click to fork', () => {
  it('opens the menu on a user CHAT BUBBLE', async () => {
    renderGroup(group('user', 'the prompt in the bubble'))
    fireEvent.contextMenu(screen.getByText('the prompt in the bubble'))
    expect(await screen.findByText(/Fork from this point/)).toBeTruthy()
  })

  it('opens the menu on a bordered assistant group', async () => {
    renderGroup(group('assistant', 'the assistant answer'))
    fireEvent.contextMenu(screen.getByText('the assistant answer'))
    expect(await screen.findByText(/Fork from this point/)).toBeTruthy()
  })

  it('opens the menu on a user group when bubbles are turned OFF', async () => {
    renderGroup(group('user', 'plain user turn'), { ...SETTINGS, chatBubbles: false })
    fireEvent.contextMenu(screen.getByText('plain user turn'))
    expect(await screen.findByText(/Fork from this point/)).toBeTruthy()
  })

  it('carries the boundary of the clicked turn into the dialog', async () => {
    renderGroup(group('user', 'pick me'))
    fireEvent.contextMenu(screen.getByText('pick me'))
    fireEvent.click(await screen.findByText(/Fork from this point/))
    expect(openForkDialog).toHaveBeenCalledTimes(1)
    expect(openForkDialog.mock.calls[0][0]).toMatchObject({
      conversationId: 'conv-under-test',
      forkPoint: { uuid: 'cc-uuid-boundary', role: 'user' },
    })
  })

  it('offers nothing on a chrome group -- boot has no counterpart to cut at', async () => {
    const boot = {
      type: 'boot',
      timestamp: '2026-08-19T10:00:00.000Z',
      entries: [],
      steps: [],
    } as unknown as DisplayGroup
    const { container } = renderGroup(boot)
    fireEvent.contextMenu(container.firstElementChild as Element)
    expect(screen.queryByText(/Fork from this point/)).toBeNull()
  })
})
