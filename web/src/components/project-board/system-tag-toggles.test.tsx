/**
 * THE ROW IS THE REGISTRY, and the editor's tag array is still ONE array.
 *
 * Two things break silently here and neither shows up in a screenshot:
 *
 *  1. A component that renders a hand-written list of tags instead of
 *     `SYSTEM_TAGS`. It looks identical the day it ships and stops offering the
 *     next tag anyone registers. So these tests never name a tag they expect --
 *     they fold over the registry and assert the row matches it, order included.
 *  2. A toggle that writes through a second mutation route. The row edits the
 *     SAME `tags` state the free-text input edits, so a save carries whatever
 *     the row did; a toggle with its own path would save nothing, or save
 *     twice, and the card would look right on screen either way.
 */

import { SYSTEM_TAGS } from '@shared/board-system-tags'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, test, vi } from 'vitest'
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
    created: '2026-08-22T00:00:00.000Z',
    mtime: 0,
    body: 'Some existing body content.',
    bodyPreview: 'Some existing body content.',
    ...over,
  }
}

type SavePatch = { title?: string; body?: string; priority?: string; tags?: string[] }

async function editor(t: ProjectTask) {
  const onSave = vi.fn(async (_id: string, _patch: SavePatch) => undefined)
  const { TaskEditor } = await import('./task-editor')
  render(
    <TaskEditor
      task={t}
      conversationId="conv-1"
      onSave={onSave}
      onMove={vi.fn(async () => true)}
      onRun={vi.fn()}
      onClose={vi.fn()}
    />,
  )
  return onSave
}

/** The toggle for a tag, addressed by its registry help text -- so a test can
 *  find it without knowing which word it is. */
function toggle(detail: string): HTMLElement {
  return screen.getByTitle(detail)
}

describe('the toggle row', () => {
  test('renders EVERY system tag, in the registry order, with its detail as help text', async () => {
    const { SystemTagToggles } = await import('./system-tag-toggles')
    render(<SystemTagToggles tags={[]} onToggle={vi.fn()} />)

    const rendered = screen.getAllByRole('button').map(b => b.textContent)
    expect(rendered).toEqual(SYSTEM_TAGS.map(t => t.tag))
    for (const entry of SYSTEM_TAGS) expect(toggle(entry.detail).textContent).toBe(entry.tag)
  })

  test('a toggle is pressed exactly when the card carries the tag', async () => {
    const { SystemTagToggles } = await import('./system-tag-toggles')
    const [first, second] = SYSTEM_TAGS
    render(<SystemTagToggles tags={[second.tag]} onToggle={vi.fn()} />)

    expect(toggle(second.detail).getAttribute('aria-pressed')).toBe('true')
    expect(toggle(first.detail).getAttribute('aria-pressed')).toBe('false')
  })

  test('clicking reports the tag -- the row never mutates, the owner of the array does', async () => {
    const { SystemTagToggles } = await import('./system-tag-toggles')
    const onToggle = vi.fn()
    render(<SystemTagToggles tags={[]} onToggle={onToggle} />)

    fireEvent.click(toggle(SYSTEM_TAGS[0].detail))
    expect(onToggle).toHaveBeenCalledWith(SYSTEM_TAGS[0].tag)
  })
})

describe('the card editor', () => {
  test('toggling a system tag ON is what the existing save path writes', async () => {
    const entry = SYSTEM_TAGS[0]
    const onSave = await editor(task())
    await screen.findByLabelText('Task title')

    fireEvent.click(toggle(entry.detail))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].tags).toEqual([entry.tag])
  })

  test('toggling one OFF removes only that tag, and keeps a tag the registry has never heard of', async () => {
    const entry = SYSTEM_TAGS[0]
    const onSave = await editor(task({ tags: [entry.tag, 'hand-written'] }))
    await screen.findByLabelText('Task title')

    fireEvent.click(toggle(entry.detail))
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].tags).toEqual(['hand-written'])
  })

  /**
   * THE ESCAPE HATCH STAYS OPEN. The row is a shortcut for the words the
   * machinery knows; the moment it becomes the only way to put a word on a
   * card, every ad-hoc label on the board becomes unreachable.
   */
  test('free-text tag entry still takes a word that is not in the registry', async () => {
    const onSave = await editor(task())
    const input = await screen.findByLabelText('Add tag to task')

    fireEvent.change(input, { target: { value: 'not-a-system-tag' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].tags).toEqual(['not-a-system-tag'])
  })

  test('a toggle and a typed tag land in ONE array -- there is only one tags state', async () => {
    const entry = SYSTEM_TAGS[0]
    const onSave = await editor(task())
    const input = await screen.findByLabelText('Add tag to task')

    fireEvent.click(toggle(entry.detail))
    fireEvent.change(input, { target: { value: 'typed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByText('Save'))

    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(1))
    expect(onSave.mock.calls[0][1].tags).toEqual([entry.tag, 'typed'])
  })
})
