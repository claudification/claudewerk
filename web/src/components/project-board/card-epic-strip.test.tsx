/**
 * Opening a child card said NOTHING about the epic it belongs to, and there was
 * no way from a child to its parent without closing the editor and hunting the
 * board. These lock the three shapes the strip has to get right.
 */

import { buildEpicIndex } from '@shared/epic-cards'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask, ProjectTaskMeta } from '@/hooks/use-project'
import { CardEpicStrip } from './card-epic-strip'

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

const readTask = vi.fn(async (slug: string) => {
  const found = BOARD.find(c => c.slug === slug)
  return found ? full(found) : null
})

vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: BOARD, readTask }),
}))

afterEach(() => {
  cleanup()
  readTask.mockClear()
})

test('a child card names its epic, in the epic colour, with the parent rollup', () => {
  render(<CardEpicStrip task={full(BOARD[1])} conversationId="conv-1" onOpenTask={vi.fn()} />)
  expect(screen.getByText('ANVIL: inline interaction language')).toBeTruthy()
  // 1 of the 2 children is done -- the strip carries the PARENT's progress.
  expect(screen.getByText('1/2')).toBeTruthy()
})

test('clicking a child strip opens the epic card, without closing the editor', async () => {
  const onOpenTask = vi.fn()
  render(<CardEpicStrip task={full(BOARD[1])} conversationId="conv-1" onOpenTask={onOpenTask} />)
  fireEvent.click(screen.getByRole('button'))
  await waitFor(() => expect(onOpenTask).toHaveBeenCalledTimes(1))
  expect(readTask).toHaveBeenCalledWith('anvil-epic')
  expect(onOpenTask.mock.calls[0][0].slug).toBe('anvil-epic')
})

test('without a navigation handler the strip still names the epic, just is not a button', () => {
  render(<CardEpicStrip task={full(BOARD[1])} conversationId="conv-1" />)
  expect(screen.getByText('ANVIL: inline interaction language')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

test('an epic card says it IS one, and does not offer to navigate to itself', () => {
  render(<CardEpicStrip task={full(BOARD[0])} conversationId="conv-1" onOpenTask={vi.fn()} />)
  expect(screen.getByText('EPIC')).toBeTruthy()
  expect(screen.getByText('2 cards')).toBeTruthy()
  expect(screen.queryByRole('button')).toBeNull()
})

test('a card pointing at an epic that is not on the board says so', () => {
  render(<CardEpicStrip task={full(BOARD[4])} conversationId="conv-1" onOpenTask={vi.fn()} />)
  expect(screen.getByText('epic-that-vanished')).toBeTruthy()
  expect(screen.getByText('is not on this board')).toBeTruthy()
})

test('a loose card renders nothing at all -- no "unparented" chip', () => {
  const { container } = render(<CardEpicStrip task={full(BOARD[3])} conversationId="conv-1" onOpenTask={vi.fn()} />)
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
