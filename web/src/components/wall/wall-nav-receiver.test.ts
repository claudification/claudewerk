/**
 * The receiving half, which for two generations did not exist.
 *
 * `navigateFromWall` could post to the opener and broadcast to a reloaded popup,
 * and nothing anywhere listened -- so both routes were dead clicks that looked
 * exactly like a working build. These tests assert the thing that was missing:
 * a message that ARRIVES moves the main window's stores, and one that is forged
 * or foreign does not.
 */

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCommitModalStore } from '@/hooks/use-commit-modals'
import { useConversationsStore } from '@/hooks/use-conversations'
import { KANBAN_MODAL } from '@/hooks/use-kanban-modal'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { isWallNavIntent, receiveWallNav, useWallNavReceiver } from './wall-nav-receiver'
import { WALL_NAV_MESSAGE } from './wall-navigate'
import { WALL_MODAL } from './wall-state'

const PROJECT = 'claude:///Users/j/remote-claude'

afterEach(() => {
  // RTL's auto-cleanup only arms with `globals: true`, which this config does
  // not set -- without this an earlier test's receiver is still listening and
  // the "refuses to arm" cases pass for the wrong reason.
  cleanup()
  window.name = ''
  useModalManagerStore.setState({ records: {} })
  useConversationsStore.setState({ pendingEpicReveal: null, pendingTaskEdit: null, selectedConversationId: null })
  useCommitModalStore.setState({ hash: null })
  vi.restoreAllMocks()
})

/** The exact envelope `navigateFromWall` puts on the wire. */
function envelope(intent: unknown): unknown {
  return { type: WALL_NAV_MESSAGE, intent }
}

/** Deliver a same-origin `message` event, as the opener would receive it. */
function deliver(data: unknown, origin = window.location.origin): void {
  act(() => {
    window.dispatchEvent(new MessageEvent('message', { data, origin }))
  })
}

describe('isWallNavIntent', () => {
  it('accepts every kind the wall can send', () => {
    expect(isWallNavIntent({ kind: 'epic', project: PROJECT, id: 'e' })).toBe(true)
    expect(isWallNavIntent({ kind: 'card', project: PROJECT, id: 'c' })).toBe(true)
    expect(isWallNavIntent({ kind: 'conversation', id: 'conv_a' })).toBe(true)
    expect(isWallNavIntent({ kind: 'commit', hash: 'abc123' })).toBe(true)
  })

  it('refuses junk, missing fields and unknown kinds', () => {
    // A validator that accepts everything is not a validator -- postMessage
    // reaches this window from anything holding a handle on it.
    expect(isWallNavIntent(null)).toBe(false)
    expect(isWallNavIntent('epic')).toBe(false)
    expect(isWallNavIntent({ kind: 'epic', id: 'e' })).toBe(false)
    expect(isWallNavIntent({ kind: 'conversation', id: '' })).toBe(false)
    expect(isWallNavIntent({ kind: 'drop-database' })).toBe(false)
  })
})

describe('receiveWallNav', () => {
  it('opens the epic and RAISES this window -- the raise is half the promise', () => {
    const focus = vi.spyOn(window, 'focus').mockImplementation(() => {})

    expect(receiveWallNav(envelope({ kind: 'epic', project: PROJECT, id: 'epic-the-wall' }))).toBe(true)

    expect(useConversationsStore.getState().pendingEpicReveal).toEqual({ epicId: 'epic-the-wall' })
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]).toBeTruthy()
    expect(focus).toHaveBeenCalled()
  })

  it('focuses a conversation', () => {
    expect(receiveWallNav(envelope({ kind: 'conversation', id: 'conv_a', via: 'wall-pulse' }))).toBe(true)
    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_a')
  })

  it('opens a commit detail', () => {
    expect(receiveWallNav(envelope({ kind: 'commit', hash: 'deadbeef' }))).toBe(true)
    expect(useCommitModalStore.getState().hash).toBe('deadbeef')
  })

  it('ignores a wrong envelope type and a malformed intent', () => {
    expect(receiveWallNav({ type: 'something-else', intent: { kind: 'epic', project: PROJECT, id: 'e' } })).toBe(false)
    expect(receiveWallNav(envelope({ kind: 'epic' }))).toBe(false)
    expect(useModalManagerStore.getState().records[KANBAN_MODAL.id]).toBeUndefined()
  })
})

describe('useWallNavReceiver', () => {
  it('MOUNTS the postMessage listener -- this is the half that did not exist', () => {
    renderHook(() => useWallNavReceiver())

    deliver(envelope({ kind: 'card', project: PROJECT, id: 'wall-navigation-and-hover' }))

    expect(useConversationsStore.getState().pendingTaskEdit).toEqual({ slug: 'wall-navigation-and-hover' })
  })

  it('drops a message from another origin', () => {
    renderHook(() => useWallNavReceiver())

    deliver(envelope({ kind: 'card', project: PROJECT, id: 'evil' }), 'https://evil.example')

    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })

  it('answers the BroadcastChannel fallback the reloaded popup uses', async () => {
    renderHook(() => useWallNavReceiver())

    const channel = new BroadcastChannel(WALL_NAV_MESSAGE)
    channel.postMessage(envelope({ kind: 'conversation', id: 'conv_broadcast' }))
    // Channel delivery is a task, not a microtask.
    await act(() => new Promise(resolve => setTimeout(resolve, 0)))
    channel.close()

    expect(useConversationsStore.getState().selectedConversationId).toBe('conv_broadcast')
  })

  it('REFUSES to arm inside the wall popup, so a broadcast cannot loop back into it', () => {
    window.name = WALL_MODAL.id
    renderHook(() => useWallNavReceiver())

    deliver(envelope({ kind: 'card', project: PROJECT, id: 'loop' }))

    expect(useConversationsStore.getState().pendingTaskEdit).toBeNull()
  })

  it('stops listening once the dashboard unmounts', () => {
    const { unmount } = renderHook(() => useWallNavReceiver())
    unmount()

    deliver(envelope({ kind: 'conversation', id: 'conv_after_unmount' }))

    expect(useConversationsStore.getState().selectedConversationId).toBeNull()
  })
})
