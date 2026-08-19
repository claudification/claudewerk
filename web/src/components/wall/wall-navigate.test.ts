/**
 * `navigateFromWall`: the click has to land somewhere, and it has to be honest
 * when it cannot.
 *
 * A dead click -- one that silently does nothing because the window it aimed at
 * is gone -- is indistinguishable from a broken build. That is the failure these
 * three paths exist to prevent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { KANBAN_MODAL } from '@/hooks/use-kanban-modal'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { navigateFromWall, WALL_NAV_MESSAGE } from './wall-navigate'
import { WALL_MODAL } from './wall-state'

const PROJECT = 'claude:///Users/j/remote-claude'

afterEach(() => {
  window.name = ''
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({ pendingEpicReveal: null, pendingTaskEdit: null })
  vi.restoreAllMocks()
})

/** Pretend this JS context IS the detached wall popup. */
function asDetachedWall(opener: unknown): void {
  window.name = WALL_MODAL.id
  Object.defineProperty(window, 'opener', { value: opener, configurable: true, writable: true })
}

describe('navigateFromWall', () => {
  it('opens the epic HERE when the wall is not its own context, and raises the window', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})

    expect(navigateFromWall({ kind: 'epic', project: PROJECT, id: 'epic-the-wall' })).toBe('here')

    expect(useConversationsStore.getState().pendingEpicReveal).toEqual({ epicId: 'epic-the-wall' })
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]).toBeTruthy()
    expect(focus).toHaveBeenCalled()
  })

  it('opens a CARD one level down, on its own project board', () => {
    navigateFromWall({ kind: 'card', project: PROJECT, id: 'wall-pane-pinned-epics' })

    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'wall-pane-pinned-epics' })
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]?.scope).toEqual({
      type: 'project',
      uri: PROJECT,
    })
  })

  it('CROSSES TO THE OPENER when the wall is a separate window, and raises IT', () => {
    const opener = { closed: false, postMessage: vi.fn(), focus: vi.fn() }
    asDetachedWall(opener)

    expect(navigateFromWall({ kind: 'epic', project: PROJECT, id: 'epic-the-wall' })).toBe('opener')

    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: WALL_NAV_MESSAGE, intent: { kind: 'epic', project: PROJECT, id: 'epic-the-wall' } },
      window.location.origin,
    )
    expect(opener.focus).toHaveBeenCalled()
    // The wall did NOT navigate itself: it is a driver, not a destination.
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]).toBeUndefined()
  })

  it('SAYS SO when the opener is closed, instead of swallowing the click', () => {
    asDetachedWall({ closed: true, postMessage: vi.fn(), focus: vi.fn() })
    const toasts: unknown[] = []
    window.addEventListener('rclaude-toast', e => toasts.push(e))

    expect(navigateFromWall({ kind: 'epic', project: PROJECT, id: 'epic-the-wall' })).toBe('dead-opener')
    expect(toasts).toHaveLength(1)
  })

  it('falls back to a broadcast when the opener REFERENCE is gone (the popup reloaded)', () => {
    asDetachedWall(null)

    expect(navigateFromWall({ kind: 'card', project: PROJECT, id: 'a-card' })).toBe('broadcast')
    // Still not handled HERE -- the wall never becomes the destination, whichever
    // route the intent takes out of it.
    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })
})
