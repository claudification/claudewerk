/**
 * REGRESSION: opening a card stole focus into the title, which killed every
 * bare-key shortcut on it.
 *
 * `useKeyLayer` deliberately auto-blocks bare keys while a text input is
 * focused (task-editor.tsx: "Bare keys -- auto-blocked when a text input /
 * CodeMirror is focused"). Radix focuses the first focusable child on open, and
 * that is the title <input>. So L (launch), W (work on this) and A (archive)
 * did nothing on a freshly opened card, and you could not tell why.
 *
 * The rule: a card WITH content opens to be READ -- nothing focused. A BLANK
 * card is being created, so the title keeps the cursor.
 */

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import type { ProjectTask } from '@/hooks/use-project'

// The editor now shows the card's epic at the top, which reads the project
// cache. These tests are about FOCUS, so the board is empty and the strip
// renders nothing -- but the hook still has to exist.
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
  // A `vi.mock` factory REPLACES the module wholesale, so every symbol the
  // component tree reaches for has to be here or the import throws before a
  // single test body runs. These two arrived with the launch/kanban wiring and
  // were never added; the shiki resolution error masked them.
  findBestConversationForProject: () => undefined,
  wsSend: vi.fn(() => true),
}))

afterEach(cleanup)

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    slug: 'a-card',
    status: 'open',
    title: 'A card',
    tags: [],
    refs: [],
    created: '2026-08-14T00:00:00.000Z',
    mtime: 0,
    body: 'Some existing body content.',
    bodyPreview: 'Some existing body content.',
    ...over,
  }
}

function renderEditor(mod: { TaskEditor: React.ComponentType<Record<string, unknown>> }, t: ProjectTask) {
  return render(
    <mod.TaskEditor
      task={t}
      conversationId="conv-1"
      onSave={vi.fn()}
      onMove={vi.fn()}
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  )
}

test('a card with content does NOT focus the title on open', async () => {
  const mod = await import('./task-editor')
  renderEditor(mod as never, task())
  await waitFor(() => expect(screen.getByLabelText('Task title')).toBeTruthy())
  expect(document.activeElement).not.toBe(screen.getByLabelText('Task title'))
})

test('a blank card DOES focus the title -- that one is being created', async () => {
  const mod = await import('./task-editor')
  renderEditor(mod as never, task({ body: '', bodyPreview: '' }))
  await waitFor(() => expect(screen.getByLabelText('Task title')).toBeTruthy())
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Task title')))
})

test('the read view needs a DOUBLE click to become the editor', async () => {
  const mod = await import('./task-editor')
  renderEditor(mod as never, task())
  const view = await screen.findByTitle('Double-click to edit')

  fireEvent.click(view)
  expect(screen.queryByTitle('Double-click to edit')).toBeTruthy()

  fireEvent.doubleClick(view)
  await waitFor(() => expect(screen.queryByTitle('Double-click to edit')).toBeNull())
})

test('L reaches the launch handler on a freshly opened card', async () => {
  const mod = await import('./task-editor')
  const onRun = vi.fn()
  render(
    <mod.TaskEditor
      task={task()}
      conversationId="conv-1"
      onSave={vi.fn()}
      onMove={vi.fn()}
      onRun={onRun}
      onClose={vi.fn()}
    />,
  )
  await waitFor(() => expect(screen.getByLabelText('Task title')).toBeTruthy())
  fireEvent.keyDown(document, { key: 'l' })
  await waitFor(() => expect(onRun).toHaveBeenCalledTimes(1))
})
