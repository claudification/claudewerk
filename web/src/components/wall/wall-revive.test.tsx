/**
 * THE WALL SURVIVES A DISCONNECT -- the census, the re-pull, and the mark.
 *
 * Three claims, and the first is the one that keeps the other two honest:
 *
 *  1. CENSUS. Every pull feed the pane registry DECLARES actually took a hold of
 *     the revive seam once the whole surface is mounted. This is what a stub
 *     cannot fake: a seam wired behind one pane leaves five feeds unrevived and
 *     `unrevivedWallFeeds()` names them.
 *  2. EXACTLY ONCE. A reconnect re-pulls each feed one time. Not zero -- that was
 *     the bug. Not thirteen -- A4 and A6 share one sheaf response and firing per
 *     PANE would double it.
 *  3. THE MARK. A feed that could not be re-read keeps its last number and says
 *     STALE, rather than presenting a pre-disconnect figure as current.
 *
 * The wall's whole premise is being believed from across a room with nobody
 * touching it, so a number with no way of saying "I predate the outage" is worse
 * than no number.
 */

import { act, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { feedPulls, resetWallRevive, type WallFeedId } from '@/lib/wall/revive-store'
import { stubWallHttp } from './wall-feed-stubs'
import { WALL_PULL_FEEDS } from './wall-pane-registry'
import { unrevivedWallFeeds } from './wall-revive-census'
import { installWallTestHooks, openTheWall, pane, wallRoot } from './wall-test-utils'

vi.mock('@/hooks/project-task-wire', () => ({
  sendBoardOp: vi.fn(async () => ({ pinned: [] })),
  installProjectHandler: vi.fn(),
}))
vi.mock('@/lib/epic-inspect-api', () => ({
  fetchActiveRuns: vi.fn(async () => ({ ok: true, data: [] })),
  inspectRun: vi.fn(async () => ({ ok: true, data: null })),
}))

/** The broker, present or absent. Read fresh on every request. */
let answering = true

/** The socket came back. `connectSeq` is the codebase's reconnect signal and the
 *  only thing the seam listens to. */
function reconnect(): void {
  act(() => {
    useConversationsStore.setState({ connectSeq: useConversationsStore.getState().connectSeq + 1 })
  })
}

const census = (): WallFeedId[] => [...WALL_PULL_FEEDS].toSorted()
const pullsNow = (): Record<string, number> => Object.fromEntries(census().map(f => [f, feedPulls(f)]))

installWallTestHooks()

beforeEach(() => {
  answering = true
  resetWallRevive()
  useConversationsStore.setState({ connectSeq: 1 })
  stubWallHttp(() => answering)
})

describe('the wall survives a disconnect', () => {
  it('registers EVERY pull feed the registry declares -- census, not a count', async () => {
    // The declaration itself, pinned. A pane that quietly drops its `feeds: [...]`
    // line would still pass the census below (nothing declared, nothing missing),
    // so the list of what the wall pulls is asserted too.
    expect(census()).toEqual(['activity', 'burn', 'commits', 'fleet-tokens', 'pins', 'runs', 'sheaf'])

    await openTheWall()

    expect(unrevivedWallFeeds()).toEqual([])
  })

  it('re-pulls each feed EXACTLY ONCE on a reconnect', async () => {
    await openTheWall()
    await waitFor(() => expect(feedPulls('sheaf')).toBeGreaterThan(0))
    const before = pullsNow()

    reconnect()
    await waitFor(() => expect(feedPulls('sheaf')).toBe(before.sheaf + 1))

    // Everything else settles on the same commit; give the microtasks a turn and
    // then insist NOBODY went twice -- A4 and A6 share the sheaf response.
    await act(async () => {
      await Promise.resolve()
    })
    for (const feed of census()) expect(`${feed}:${feedPulls(feed)}`).toBe(`${feed}:${before[feed] + 1}`)
  })

  it('marks a number it could not re-read STALE instead of passing it off as current', async () => {
    await openTheWall()
    await waitFor(() => expect(pane('A6')?.getAttribute('data-stale')).toBe(null))

    // The broker restarted: the socket comes back, the reads do not.
    answering = false
    reconnect()

    await waitFor(() => expect(pane('A6')?.getAttribute('data-stale')).toBe('true'))
    for (const code of ['A2', 'A4', 'P2']) expect(pane(code)?.getAttribute('data-stale')).toBe('true')
    // And it is a WORD on the surface, not just an attribute: ambient mode has no
    // chrome and no cursor, so a tooltip would say nothing to the room.
    expect(wallRoot().querySelector('.wall-stale-mark')?.textContent).toBe('STALE')
  })

  it('does not cry stale over a feed that never landed anything', async () => {
    answering = false
    await openTheWall()
    await waitFor(() => expect(feedPulls('sheaf')).toBeGreaterThan(0))

    // Nothing arrived, so there is no number on screen to misread. "No feed yet"
    // and "this is from before the outage" are different claims and only one of
    // them is true here.
    expect(pane('A6')?.getAttribute('data-stale')).toBe(null)
  })
})
