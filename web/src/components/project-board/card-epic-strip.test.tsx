/**
 * Opening a child card said NOTHING about the epic it belongs to, and there was
 * no way from a child to its parent without closing the editor and hunting the
 * board. These lock the three shapes the strip has to get right.
 */

import { buildEpicIndex } from '@shared/epic-cards'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask, ProjectTaskMeta } from '@/hooks/use-project'
import { CardEpicStrip } from './card-epic-strip'
import { revealEpic } from './reveal-epic'

function meta(slug: string, over: Partial<ProjectTaskMeta> = {}): ProjectTaskMeta {
  return {
    slug,
    status: 'open',
    title: slug,
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    bodyPreview: '',
    ...over,
  }
}

const full = (m: ProjectTaskMeta): ProjectTask => ({ ...m, body: '' })

const BOARD: ProjectTaskMeta[] = [
  meta('anvil-epic', { tags: ['epic'], title: 'ANVIL: inline interaction language' }),
  meta('anvil-code-block', { epic: 'anvil-epic', title: 'Inline code block' }),
  meta('anvil-note', { epic: 'anvil-epic', status: 'done' }),
  meta('loose-card'),
  meta('orphan', { epic: 'epic-that-vanished' }),
]

vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: BOARD, readTask: async () => null }),
}))

vi.mock('./reveal-epic', () => ({ revealEpic: vi.fn() }))

afterEach(() => {
  cleanup()
  vi.mocked(revealEpic).mockClear()
})

test('a child card names its epic, in the epic colour, with the parent rollup', () => {
  render(<CardEpicStrip task={full(BOARD[1])} conversationId="conv-1" onNavigate={vi.fn()} />)
  expect(screen.getByText('ANVIL: inline interaction language')).toBeTruthy()
  // 1 of the 2 children is done -- the strip carries the PARENT's progress.
  expect(screen.getByText('1/2')).toBeTruthy()
})

/**
 * REGRESSION: this used to hand the epic's CARD back to the open editor. You
 * stayed in the card dialog -- header swapped, body still the child's -- which
 * is neither the epic nor the surface an epic is read on.
 */
test('clicking a child strip reveals the epic, and leaves the card behind', () => {
  const onNavigate = vi.fn()
  render(<CardEpicStrip task={full(BOARD[1])} conversationId="conv-1" onNavigate={onNavigate} />)
  fireEvent.click(screen.getByRole('button'))
  expect(revealEpic).toHaveBeenCalledWith('conv-1', 'anvil-epic')
  expect(onNavigate).toHaveBeenCalledTimes(1)
})

test('an epic card says it IS one, and does not offer to navigate to itself', () => {
  render(<CardEpicStrip task={full(BOARD[0])} conversationId="conv-1" onNavigate={vi.fn()} />)
  expect(screen.getByText('EPIC')).toBeTruthy()
  expect(screen.getByText('2 cards')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

test('a card pointing at an epic that is not on the board says so', () => {
  render(<CardEpicStrip task={full(BOARD[4])} conversationId="conv-1" onNavigate={vi.fn()} />)
  expect(screen.getByText('epic-that-vanished')).toBeTruthy()
  expect(screen.getByText('is not on this board')).toBeTruthy()
})

test('a loose card renders nothing at all -- no "unparented" chip', () => {
  const { container } = render(<CardEpicStrip task={full(BOARD[3])} conversationId="conv-1" onNavigate={vi.fn()} />)
  expect(container.innerHTML).toBe('')
})

test('the index the strip reads agrees with the board -- one fold, one answer', () => {
  const index = buildEpicIndex(BOARD)
  expect(index.get('anvil-epic')?.done).toBe(1)
  expect(index.get('anvil-epic')?.total).toBe(2)
  // A dangling id STILL gets a rollup -- it just has no card. This is the trap
  // the strip's `!rollup?.card` check exists for; asserting it here keeps the
  // next person from "simplifying" that back to a truthiness check.
  expect(index.has('epic-that-vanished')).toBe(true)
  expect(index.get('epic-that-vanished')?.card).toBeNull()
})
