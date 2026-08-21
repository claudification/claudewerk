/**
 * REGRESSION: swapping the card an OPEN editor is showing kept the PREVIOUS
 * card's title and body -- and then saved them onto the new card.
 *
 * `TaskEditor` seeds `title` / `body` / `editing` from props ONCE, on mount, and
 * its sync effect deliberately refreshes only status/priority/tags so a
 * background `project_changed` cannot clobber what someone is typing. That is
 * correct for a card that CHANGED. It is wrong for a card that was REPLACED:
 * everything read straight from props flipped to the new card (the epic strip,
 * the age, the `<slug>.md` footer) while the title input and the body pane kept
 * showing the old one, and `handleSave` posted those stale values to the NEW
 * card's slug. Cmd+S after following a card link overwrote the card you had
 * just navigated to with the content of the one you left.
 *
 * The fix is `key={task.slug}` at the mount sites: a different card is a
 * different editor, which is what init-only state means. Both mount sites are
 * asserted here because they must never drift apart.
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
    slug: 'child-card',
    status: 'open',
    title: 'Child card',
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    body: 'Body of the child card.',
    bodyPreview: 'Body of the child card.',
    ...over,
  }
}

const CHILD = task()
const EPIC = task({
  slug: 'anvil-epic',
  title: 'ANVIL: inline interaction language',
  body: 'Body of the epic.',
  bodyPreview: 'Body of the epic.',
})

test('the board editor follows a card swap -- title, body, and what a save writes', async () => {
  const { BoardModals } = await import('./board-modals')
  const updateTask = vi.fn(async () => undefined)
  const props = {
    conversationId: 'conv-1',
    setEditingTask: vi.fn(),
    runTask: null,
    setRunTask: vi.fn(),
    moveTask: vi.fn(async () => 'ok' as const),
    updateTask,
  }

  const { rerender } = render(<BoardModals {...props} editingTask={CHILD} />)
  await screen.findByDisplayValue('Child card')

  rerender(<BoardModals {...props} editingTask={EPIC} />)

  await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveProperty('value', EPIC.title))
  expect(screen.getByText('Body of the epic.')).toBeTruthy()
  expect(screen.queryByText('Body of the child card.')).toBeNull()

  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(updateTask).toHaveBeenCalledTimes(1))
  expect(updateTask.mock.calls[0]).toEqual([
    EPIC.slug,
    { title: EPIC.title, body: EPIC.body, priority: 'medium', tags: [] },
  ])
})

test('the transcript-side editor follows a card swap too', async () => {
  const { TaskEditorOverlay } = await import('../conversation-detail/task-editor-overlay')
  const onUpdateTask = vi.fn(async (_id: string, _patch: { title?: string; body?: string }) => undefined)
  const props = {
    conversationId: 'conv-1',
    runTaskFromEditor: null,
    onUpdateTask,
    onMoveTask: vi.fn(async () => 'ok' as const),
    onRunTask: vi.fn(),
    onCloseEditor: vi.fn(),
    onCloseRunDialog: vi.fn(),
    onSetTaskEditorTask: vi.fn(),
  }

  const { rerender } = render(<TaskEditorOverlay {...props} taskEditorTask={CHILD} />)
  await screen.findByDisplayValue('Child card')

  rerender(<TaskEditorOverlay {...props} taskEditorTask={EPIC} />)

  await waitFor(() => expect(screen.getByLabelText('Task title')).toHaveProperty('value', EPIC.title))
  fireEvent.click(screen.getByText('Save'))
  await waitFor(() => expect(onUpdateTask).toHaveBeenCalledTimes(1))
  expect(onUpdateTask.mock.calls[0][0]).toBe(EPIC.slug)
  expect(onUpdateTask.mock.calls[0][1].body).toBe(EPIC.body)
})
