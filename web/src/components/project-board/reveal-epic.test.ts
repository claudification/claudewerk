/**
 * The reveal is a NAVIGATION with two halves that have to happen together: the
 * epic id parked for whichever board picks it up, and the Kanban surface opened
 * so that there IS a board to pick it up. Parking without opening is the silent
 * click this replaced; opening without parking lands you on the epics index
 * with nothing selected.
 */

import { beforeEach, expect, test, vi } from 'vitest'

const setPendingEpicReveal = vi.fn()
const conversationsById: Record<string, { project?: string }> = {
  'conv-with-project': { project: 'claude://studio//Users/jonas/projects/remote-claude' },
  'conv-adrift': {},
}

vi.mock('@/hooks/use-conversations', () => ({
  useConversationsStore: { getState: () => ({ conversationsById, setPendingEpicReveal }) },
}))
vi.mock('@/hooks/use-kanban-modal', () => ({ openKanbanModal: vi.fn() }))
vi.mock('@/lib/toast-bus', () => ({ showToast: vi.fn() }))

const { openKanbanModal } = await import('@/hooks/use-kanban-modal')
const { showToast } = await import('@/lib/toast-bus')
const { revealEpic } = await import('./reveal-epic')

beforeEach(() => vi.clearAllMocks())

test('parks the epic AND opens the board it will be read on', () => {
  revealEpic('conv-with-project', 'anvil-epic')
  expect(setPendingEpicReveal).toHaveBeenCalledWith({ epicId: 'anvil-epic' })
  expect(openKanbanModal).toHaveBeenCalledWith('claude://studio//Users/jonas/projects/remote-claude')
})

test('no project => says so, and parks nothing that could fire on the wrong board', () => {
  revealEpic('conv-adrift', 'anvil-epic')
  expect(setPendingEpicReveal).not.toHaveBeenCalled()
  expect(openKanbanModal).not.toHaveBeenCalled()
  expect(showToast).toHaveBeenCalledTimes(1)
})
