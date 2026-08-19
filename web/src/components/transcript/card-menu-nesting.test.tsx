/**
 * REGRESSION: a card link lives INSIDE a chat bubble that already owns
 * right-click, and only ONE of the two menus may open.
 *
 * The bubble is a Radix `ContextMenu.Trigger asChild` (see `fork-point-menu`),
 * so its handler sits on an ancestor of every card link in the turn. React
 * events bubble: without a `stopPropagation()` at the link, a right-click on a
 * card would arm the fork menu as well and you would get whichever one Radix
 * drew last.
 *
 * So: the card link gets the CARD menu and no fork item; bubble text gets the
 * FORK menu and no card item. Both directions, driven through the real
 * components with a real right-click.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { CardProvider } from '@/lib/cards'
import { registerCardProvider, resetCardProviders } from '@/lib/cards'

const openForkDialog = vi.fn()
vi.mock('../fork-dialog-trigger', () => ({ openForkDialog: (...a: unknown[]) => openForkDialog(...a) }))
vi.mock('@/hooks/use-project', () => ({ useProject: () => ({ moveTask: vi.fn(), tasks: [] }) }))

const { MemoizedGroupView } = await import('./group-view')
const { CardMenuLayer } = await import('../cards/card-menu-layer')
const { useCardMenu } = await import('../cards/card-menu-bus')

import type { TranscriptSettings } from './group-view-types'
import type { DisplayGroup } from './grouping'

const CARD_PATH = '.rclaude/project/cards/wall-time-cursor.md'

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

const boardProvider: CardProvider = {
  id: 'project-board',
  matchHref: href =>
    href.includes('.rclaude/project/') && href.endsWith('.md')
      ? { provider: 'project-board', id: href.split('/').pop()?.replace('.md', '') ?? '', scope: 'claude://p' }
      : null,
  peek: () => ({
    status: 'ready',
    summary: {
      ref: { provider: 'project-board', id: 'wall-time-cursor', scope: 'claude://p' },
      kind: 'card',
      state: 'active',
      statusLabel: 'in-progress',
      detail: 'full',
      title: 'Wall time cursor',
      tags: [],
    },
  }),
  resolve: vi.fn(),
  subscribe: () => () => {},
}

function userGroup(text: string): DisplayGroup {
  return {
    type: 'user',
    timestamp: '2026-08-19T10:00:00.000Z',
    entries: [
      {
        type: 'user',
        uuid: 'cc-uuid-boundary',
        timestamp: '2026-08-19T10:00:00.000Z',
        message: { role: 'user', content: text },
      },
    ],
  } as unknown as DisplayGroup
}

function renderTurn(text: string) {
  return render(
    <>
      <MemoizedGroupView group={userGroup(text)} getResult={() => undefined} settings={SETTINGS} />
      <CardMenuLayer />
    </>,
  )
}

beforeEach(() => {
  resetCardProviders()
  registerCardProvider(boardProvider)
  useCardMenu.setState({ armed: false, target: null })
  useConversationsStore.setState({ selectedConversationId: 'conv-under-test', pendingTaskEdit: null })
})
afterEach(() => {
  cleanup()
  resetCardProviders()
  openForkDialog.mockClear()
  useConversationsStore.setState({ pendingTaskEdit: null })
})

test('right-clicking a card link inside a bubble opens the CARD menu, not the fork menu', async () => {
  const { container } = renderTurn(`look at [the card](${CARD_PATH}) please`)
  fireEvent.contextMenu(container.querySelector('a.file-link-card') as HTMLElement)

  expect(await screen.findByText('OPEN')).toBeTruthy()
  expect(screen.queryByText(/Fork from this point/)).toBeNull()
})

test('right-clicking bubble TEXT still opens the fork menu, not the card menu', async () => {
  renderTurn('the prompt in the bubble')
  fireEvent.contextMenu(screen.getByText('the prompt in the bubble'))

  expect(await screen.findByText(/Fork from this point/)).toBeTruthy()
  expect(screen.queryByText('OPEN')).toBeNull()
  expect(useCardMenu.getState().target).toBeNull()
})

test('the fork menu still cuts at the right turn when a card link is in the text', async () => {
  renderTurn(`look at [the card](${CARD_PATH}) please`)
  // The bubble owns everything that is NOT the link -- right-clicking the
  // surrounding words must behave exactly as it did before card menus existed.
  fireEvent.contextMenu(screen.getByText(/please/))
  fireEvent.click(await screen.findByText(/Fork from this point/))

  expect(openForkDialog).toHaveBeenCalledTimes(1)
  expect(openForkDialog.mock.calls[0][0]).toMatchObject({
    conversationId: 'conv-under-test',
    forkPoint: { uuid: 'cc-uuid-boundary', role: 'user' },
  })
})
