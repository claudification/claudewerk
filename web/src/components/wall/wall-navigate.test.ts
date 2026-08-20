/**
 * `navigateFromWall`: the click has to land somewhere, and it has to be honest
 * when it cannot.
 *
 * A dead click -- one that silently does nothing because the window it aimed at
 * is gone -- is indistinguishable from a broken build. That is the failure these
 * three paths exist to prevent.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCommitModalStore } from '@/hooks/use-commit-modals'
import { useConversationsStore } from '@/hooks/use-conversations'
import { KANBAN_MODAL } from '@/hooks/use-kanban-modal'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { useWallDetail } from './wall-detail-store'
import { navigateFromWall, WALL_NAV_MESSAGE } from './wall-navigate'
import { WALL_MODAL } from './wall-state'

const PROJECT = 'claude:///Users/j/remote-claude'

afterEach(() => {
  window.name = ''
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({ pendingEpicReveal: null, pendingTaskEdit: null, selectedConversationId: null })
  useCommitModalStore.setState({ hash: null })
  useWallDetail.setState({ hash: null })
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

  it('focuses a CONVERSATION, tagging the wall as the selection source', () => {
    navigateFromWall({ kind: 'conversation', id: 'conv_a', via: 'wall-pulse' })

    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_a')
  })

  it('opens a COMMIT detail', () => {
    navigateFromWall({ kind: 'commit', hash: 'deadbeefcafe' })

    expect(useCommitModalStore.getState().hash).toBe('deadbeefcafe')
  })

  it('carries a conversation across to the opener like any other intent', () => {
    const opener = { closed: false, postMessage: vi.fn(), focus: vi.fn() }
    asDetachedWall(opener)

    expect(navigateFromWall({ kind: 'conversation', id: 'conv_a' })).toBe('opener')
    expect(opener.postMessage).toHaveBeenCalledWith(
      { type: WALL_NAV_MESSAGE, intent: { kind: 'conversation', id: 'conv_a' } },
      window.location.origin,
    )
    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
  })
})

/**
 * `wall-commit-detail-in-wall`: a commit opens INSIDE the wall.
 *
 * The transport carried the destination from day one so this card would not have
 * to fork a second mechanism. What the card changed is WHERE the target lands:
 * on the wall's own detail store, which the wall surface renders inside
 * `.wall-root` -- never on the main window's commit modal, and never with a
 * `focus()` that raises the dashboard over the popup the click came from.
 */
describe('navigateFromWall with an IN-WALL target', () => {
  it('keeps the intent in the popup and does NOT raise the opener', () => {
    const opener = { closed: false, postMessage: vi.fn(), focus: vi.fn() }
    asDetachedWall(opener)

    expect(navigateFromWall({ kind: 'commit', hash: 'deadbeefcafe' }, 'wall')).toBe('wall')

    expect(useWallDetail.getState().hash).toBe('deadbeefcafe')
    expect(useCommitModalStore.getState().hash).toBeNull()
    expect(opener.postMessage).not.toHaveBeenCalled()
    expect(opener.focus).not.toHaveBeenCalled()
  })

  /**
   * THE PORTALED CASE, which is the ordinary detached wall: the DOM is in the
   * popup, the React tree is still the opener's, so `window` here IS the main
   * window. Answering "apply here and raise the window" would open the commit in
   * the dashboard and pull the dashboard in front of the second monitor -- the
   * dead-letter bug W4 exists to kill, running backwards.
   */
  it('never raises a window, even when it is running in the main one', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})

    expect(navigateFromWall({ kind: 'commit', hash: 'abc' }, 'wall')).toBe('wall')

    expect(useWallDetail.getState().hash).toBe('abc')
    expect(useCommitModalStore.getState().hash).toBeNull()
    expect(focus).not.toHaveBeenCalled()
  })

  it('falls through to the main window for a kind the wall cannot show', () => {
    // There is no in-wall epic surface, and there should not be one: an epic is
    // a place you go and WORK. A target with no answer must not eat the click.
    expect(navigateFromWall({ kind: 'epic', project: PROJECT, id: 'epic-the-wall' }, 'wall')).toBe('here')
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]).toBeTruthy()
  })

  it('still crosses to the opener when the target is the default main window', () => {
    const opener = { closed: false, postMessage: vi.fn(), focus: vi.fn() }
    asDetachedWall(opener)

    expect(navigateFromWall({ kind: 'commit', hash: 'abc' })).toBe('opener')
    expect(useCommitModalStore.getState().hash).toBeNull()
    expect(useWallDetail.getState().hash).toBeNull()
  })
})
