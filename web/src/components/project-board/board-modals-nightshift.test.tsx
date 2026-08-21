/**
 * THE NIGHTSHIFT BUTTON SETS A TAG. It used to copy the card.
 *
 * `enqueueNightshiftTask(uri, { title, description, boardRef })` wrote the
 * card's title and body into `.nightshift/queue/` and kept a `boardRef` string
 * pointing back at it. The copy went stale on the next edit, the pointer
 * dangled on the next rename, and the board could not show you that a card was
 * queued at all. Now the card IS the item: the button writes `#nightshift` and
 * the broker's scanner reads the board.
 *
 * These assert the two properties that difference buys -- the write is a TAG
 * patch on the card, and pressing the button twice cannot double-list it.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask } from '@/hooks/use-project'

vi.mock('@/hooks/use-project', () => ({
  useProject: () => ({ tasks: [], readTask: async () => null }),
}))

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ conversationsById: {}, selectedConversationId: 'conv-1' }),
    { getState: () => ({ conversationsById: {}, selectedConversationId: 'conv-1' }) },
  ),
  sendInput: vi.fn(),
  useConversations: () => [],
}))

afterEach(cleanup)

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    slug: 'some-card',
    status: 'open',
    title: 'Some card',
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    body: 'What the night run should do.',
    bodyPreview: 'What the night run should do.',
    ...over,
  }
}

type Patch = { title?: string; body?: string; priority?: string; tags?: string[] }

async function pressNightshift(editingTask: ProjectTask) {
  const { BoardModals } = await import('./board-modals')
  const updateTask = vi.fn(async (_id: string, _patch: Patch) => undefined)
  render(
    <BoardModals
      conversationId="conv-1"
      editingTask={editingTask}
      setEditingTask={vi.fn()}
      runTask={null}
      setRunTask={vi.fn()}
      moveTask={vi.fn(async () => 'some-card')}
      updateTask={updateTask}
    />,
  )
  const button = await screen.findByRole('button', { name: /nightshift/i })
  fireEvent.click(button)
  return updateTask
}

test('the button patches the card with #nightshift -- no queue entry, no copy of the body', async () => {
  const updateTask = await pressNightshift(task({ tags: ['chore'] }))

  await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
  expect(updateTask).toHaveBeenCalledWith('some-card', { tags: ['chore', 'nightshift'] })
  // The card's own text is never sent anywhere -- that is the whole point.
  expect(Object.keys(updateTask.mock.calls[0]?.[1] ?? {})).toEqual(['tags'])
})

test('a card that is already tagged is left alone -- the tag is a state, not an event', async () => {
  const updateTask = await pressNightshift(task({ tags: ['nightshift'] }))

  await new Promise(r => setTimeout(r, 0))
  expect(updateTask).not.toHaveBeenCalled()
})
