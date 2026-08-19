/**
 * What the wall ASKS FOR, which is the whole point of folding A8 on the sentinel.
 *
 * The regression these guard is the one the fold replaced: the pane used to find
 * `wall_pinned` by hydrating every project's entire board into the shared cache,
 * because only the full card carries the key. So the assertion that matters is
 * negative -- one `pinned` op per project, and never a `manifest` or a
 * `getBatch`. The wire is left REAL here (only its transport is mocked) so a
 * board-cache read sneaking back in would show up as an op nobody asked for.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { useWallPins } from './use-wall-pins'

const wire = vi.hoisted(() => ({
  sendBoardOp: vi.fn(async (_project: string, _op: string) => ({}) as Record<string, unknown>),
  installProjectHandler: vi.fn(),
}))
vi.mock('@/hooks/project-task-wire', () => wire)

const ALPHA = 'claude:///Users/j/alpha'
const BETA = 'claude:///Users/j/beta'

function row(over: Record<string, unknown> = {}) {
  return {
    project: 'whatever-the-sentinel-said',
    epicId: 'epic-the-wall',
    epicTitle: 'THE WALL',
    done: 1,
    total: 2,
    pct: 50,
    children: [],
    cap: 5,
    hidden: 0,
    movedAt: 100,
    ...over,
  }
}

/** Reply with `rows` for `project`, and an empty watchlist for anything else. */
function serve(rowsByProject: Record<string, unknown[]>) {
  wire.sendBoardOp.mockImplementation(async (project: string) => ({ pinned: rowsByProject[project] ?? [] }))
}

beforeEach(() => {
  wire.sendBoardOp.mockClear()
  useConversationsStore.setState({
    conversationsById: {
      a: { id: 'a', project: ALPHA } as Conversation,
      b: { id: 'b', project: BETA } as Conversation,
    },
    projectSettings: {},
  })
})
afterEach(() => vi.restoreAllMocks())

describe('useWallPins', () => {
  it('asks each project for the FOLD and never hydrates a board', async () => {
    serve({ [ALPHA]: [row()] })
    const { result } = renderHook(() => useWallPins())

    await waitFor(() => expect(result.current).toHaveLength(1))

    const ops = wire.sendBoardOp.mock.calls.map(([project, op]) => `${op}:${project}`)
    expect(ops.toSorted()).toEqual([`pinned:${ALPHA}`, `pinned:${BETA}`])
    expect(ops.some(o => o.startsWith('manifest') || o.startsWith('getBatch'))).toBe(false)
  })

  it('stamps the project the row was asked FOR, not the one it came back naming', async () => {
    serve({ [ALPHA]: [row()] })
    useConversationsStore.setState({
      projectSettings: { [projectIdentityKey(ALPHA)]: { label: 'ALPHA', icon: '#', color: 'teal' } },
    })

    const { result } = renderHook(() => useWallPins())
    await waitFor(() => expect(result.current).toHaveLength(1))

    expect(result.current[0]).toMatchObject({
      project: ALPHA,
      projectName: 'ALPHA',
      projectIcon: '#',
      projectColor: 'teal',
    })
  })

  it('sorts the fleet by what MOVED last, across projects', async () => {
    serve({
      [ALPHA]: [row({ epicId: 'old', movedAt: 10 })],
      [BETA]: [row({ epicId: 'new', movedAt: 900 })],
    })

    const { result } = renderHook(() => useWallPins())
    await waitFor(() => expect(result.current).toHaveLength(2))
    expect(result.current.map(r => r.epicId)).toEqual(['new', 'old'])
  })

  it('keeps the last known watchlist when an ask FAILS, rather than blanking it', async () => {
    serve({ [ALPHA]: [row()] })
    const { result } = renderHook(() => useWallPins())
    await waitFor(() => expect(result.current).toHaveLength(1))

    // The socket is gone, so every op rejects. A watchlist that emptied itself
    // on one bad round trip would read as "you are watching nothing".
    wire.sendBoardOp.mockRejectedValue(new Error('not connected to the broker'))
    act(() => {
      useConversationsStore.setState({
        conversationsById: {
          a: { id: 'a', project: ALPHA } as Conversation,
          b: { id: 'b', project: BETA } as Conversation,
          c: { id: 'c', project: 'claude:///Users/j/gamma' } as Conversation,
        },
      })
    })

    await waitFor(() => expect(wire.sendBoardOp.mock.calls.length).toBe(5))
    expect(result.current).toHaveLength(1)
  })

  it('drops a project that left the registry without waiting for a reply', async () => {
    serve({ [ALPHA]: [row()], [BETA]: [row({ epicId: 'beta-epic' })] })
    const { result } = renderHook(() => useWallPins())
    await waitFor(() => expect(result.current).toHaveLength(2))

    act(() => {
      useConversationsStore.setState({ conversationsById: { a: { id: 'a', project: ALPHA } as Conversation } })
    })

    await waitFor(() => expect(result.current.map(r => r.epicId)).toEqual(['epic-the-wall']))
  })
})
