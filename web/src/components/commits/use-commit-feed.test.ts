/**
 * REGRESSION. `useCommitFeed` used to call `fetch` with no `catch` anywhere in
 * the chain, so anything that made the request THROW rather than answer -- being
 * offline, a broker that is down, a body that is not JSON -- produced an
 * unhandled rejection and left `loading` true forever. A feed that says
 * "Loading..." for the rest of the session is indistinguishable from a slow one,
 * which is exactly the failure you cannot debug from a screenshot.
 *
 * Surfaced 2026-08-20 by THE WALL's P2 pane, which mounts this feed the moment
 * the wall opens, so every wall suite that did not stub `fetch` started printing
 * unhandled rejections.
 */

import { renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useCommitFeed } from './use-commit-feed'

afterEach(() => vi.unstubAllGlobals())

describe('useCommitFeed', () => {
  it('stops loading when the request THROWS, not just when it 404s', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch')
      }),
    )

    const { result } = renderHook(() => useCommitFeed({}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.commits).toEqual([])
    expect(result.current.hasMore).toBe(false)
  })

  it('still stops loading on a non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 500 })),
    )

    const { result } = renderHook(() => useCommitFeed({}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.commits).toEqual([])
  })

  it('absorbs a page and reports whether the ledger goes back further', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ commits: [], conversations: [], projects: [], cursor: 'c1', hasMore: true }), {
            status: 200,
          }),
      ),
    )

    const { result } = renderHook(() => useCommitFeed({}))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.hasMore).toBe(true)
  })
})
