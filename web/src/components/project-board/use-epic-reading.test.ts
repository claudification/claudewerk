/**
 * The board end of the reveal. Three things have to happen together or the
 * navigation lands somewhere useless: the card editor closes (it is a dialog on
 * top of the surface we were asked to show), the view flips to EPICS (an epic is
 * not read as a kanban card), and the epic gets picked (landing on the index
 * with nothing selected answers nothing).
 */

import { renderHook } from '@testing-library/react'
import { beforeEach, expect, test, vi } from 'vitest'

let pending: { epicId: string } | null = null
const setPendingEpicReveal = vi.fn((next: { epicId: string } | null) => {
  pending = next
})

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: Object.assign((sel: (s: unknown) => unknown) => sel({ pendingEpicReveal: pending }), {
    getState: () => ({ setPendingEpicReveal }),
  }),
}))

const { useEpicReading } = await import('./use-epic-reading')

beforeEach(() => {
  pending = null
  vi.clearAllMocks()
})

function setup() {
  const updateView = vi.fn()
  const setEditingTask = vi.fn()
  const view = renderHook(() => useEpicReading({ updateView, setEditingTask }))
  return { ...view, updateView, setEditingTask }
}

test('no intent parked => the board is left exactly where it was', () => {
  const { result, updateView, setEditingTask } = setup()
  expect(result.current.readingEpic).toBeNull()
  expect(updateView).not.toHaveBeenCalled()
  expect(setEditingTask).not.toHaveBeenCalled()
})

test('an intent closes the editor, flips to EPICS, and picks the epic', () => {
  const { result, rerender, updateView, setEditingTask } = setup()

  pending = { epicId: 'anvil-epic' }
  rerender()

  expect(setEditingTask).toHaveBeenCalledWith(null)
  expect(updateView).toHaveBeenCalledWith('view', 'epics')
  expect(result.current.readingEpic).toBe('anvil-epic')
  // Claimed, not left on the counter for the next board to re-fire.
  expect(setPendingEpicReveal).toHaveBeenCalledWith(null)
})

test('a claimed intent does not fire again on the next render', () => {
  const { rerender, updateView } = setup()

  pending = { epicId: 'anvil-epic' }
  rerender()
  rerender()

  expect(updateView).toHaveBeenCalledTimes(1)
})
