/**
 * REGRESSION: "work on this epic" from a board whose project is NOT the app's
 * current selection.
 *
 * The selector resolved both its card source and its send target from
 * `selectedConversationId`, so a board opened for project A while conversation B
 * was selected preselected A's card ids against B's card list -- an empty
 * selector -- and, if you submitted anyway, fired the prompt at B. A detached
 * board makes that the normal case: "selected" then means the OTHER window's
 * selection.
 */

import { expect, it } from 'vitest'
import { resolveBatchTargets } from './target'

const LIVE = [
  { id: 'board-conv', status: 'active' },
  { id: 'selected-conv', status: 'active' },
  { id: 'dead-conv', status: 'ended' },
]

it('prefers the conversation the dispatch site pinned', () => {
  expect(resolveBatchTargets(LIVE, 'board-conv', 'selected-conv')).toEqual({
    relay: 'board-conv',
    target: 'board-conv',
  })
})

it('falls back to the app selection when nothing is pinned', () => {
  expect(resolveBatchTargets(LIVE, null, 'selected-conv')).toEqual({
    relay: 'selected-conv',
    target: 'selected-conv',
  })
})

it('ignores a pinned conversation that has ended', () => {
  expect(resolveBatchTargets(LIVE, 'dead-conv', 'selected-conv').target).toBe('selected-conv')
})

it('never names an ended conversation as the send target', () => {
  expect(resolveBatchTargets(LIVE, 'dead-conv', 'dead-conv').target).toBeNull()
})

it('relays through any live conversation, but refuses to SEND to an arbitrary one', () => {
  // Reading is harmless (the board op carries the project uri); sending is not.
  const out = resolveBatchTargets(LIVE, null, null)
  expect(out.relay).toBe('board-conv')
  expect(out.target).toBeNull()
})

it('has nothing to offer when every conversation is ended', () => {
  const ended = [{ id: 'dead-conv', status: 'ended' }]
  expect(resolveBatchTargets(ended, 'dead-conv', 'dead-conv')).toEqual({ relay: null, target: null })
})
