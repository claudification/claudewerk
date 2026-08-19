/**
 * The chip is the card, in a row that only has a path.
 *
 * Two things it must never do: swallow the id when the board has not answered
 * yet (an empty chip is indistinguishable from a broken row), and let its click
 * reach the row underneath -- the row toggles its output pane, so opening a card
 * would also flap the pane open or shut.
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { CardLookup, CardProvider } from '@/lib/cards'
import { registerCardProvider, resetCardProviders } from '@/lib/cards'
import { CardChip } from './card-chip'

const CARD_PATH = '.rclaude/project/cards/wall-time-cursor.md'

function provider(lookup: CardLookup): CardProvider {
  return {
    id: 'test-board',
    matchHref: href =>
      href.endsWith('.md') && href.includes('/cards/')
        ? { provider: 'test-board', id: href.split('/').pop()?.replace('.md', '') ?? '', scope: 'claude://p' }
        : null,
    peek: () => lookup,
    resolve: vi.fn(),
    subscribe: () => () => {},
  }
}

function ready(title: string): CardLookup {
  return {
    status: 'ready',
    summary: {
      ref: { provider: 'test-board', id: 'wall-time-cursor', scope: 'claude://p' },
      kind: 'card',
      state: 'active',
      statusLabel: 'in-progress',
      detail: 'full',
      title,
      tags: [],
    },
  }
}

beforeEach(() => {
  resetCardProviders()
  useConversationsStore.setState({ pendingTaskEdit: null })
})
afterEach(cleanup)

describe('CardChip', () => {
  test('shows the card title once the board answers', () => {
    registerCardProvider(provider(ready('Wall time cursor')))
    render(<CardChip path={CARD_PATH} fallback="cards/wall-time-cursor.md" />)
    expect(screen.getByRole('button').textContent).toContain('Wall time cursor')
  })

  test('falls back to the id while the board is still answering', () => {
    registerCardProvider(provider({ status: 'resolving' }))
    render(<CardChip path={CARD_PATH} fallback="cards/wall-time-cursor.md" />)
    expect(screen.getByRole('button').textContent).toContain('wall-time-cursor')
  })

  test('opens the card editor and does not toggle the row it sits in', () => {
    registerCardProvider(provider(ready('Wall time cursor')))
    const rowClick = vi.fn()
    render(
      <div onClick={rowClick}>
        <CardChip path={CARD_PATH} fallback="cards/wall-time-cursor.md" />
      </div>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'wall-time-cursor' })
    expect(rowClick).not.toHaveBeenCalled()
  })

  test('renders the plain path when no provider claims it', () => {
    registerCardProvider(provider(ready('Wall time cursor')))
    render(<CardChip path="src/main.tsx" fallback="src/main.tsx" />)
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.getByText('src/main.tsx')).toBeTruthy()
  })
})
