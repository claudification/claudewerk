import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it } from 'vitest'
import { useWallFilter, useWallFilterStore, type WallFilterResult, type WallRowFacets } from './filter'

const store = () => useWallFilterStore.getState()

/** Pulse-shaped rows: they already carry the facet names. */
const FLEET: WallRowFacets[] = [
  { title: 'ceiling copy', project: 'remote-claude', action: 'waiting', band: 'needs', contextPct: 80, costUsd: 4 },
  { title: 'neon ramp', project: 'anvil', action: 'editing', band: 'working', contextPct: 20, costUsd: 0.5 },
  { title: 'node stats', project: 'remote-claude', action: 'idle', band: 'idle', contextPct: 10, costUsd: 0.1 },
]

/** Commit-river-shaped rows: a different shape entirely, projected on the way in. */
interface Commit {
  sha: string
  repo: string
  subject: string
}
const COMMITS: Commit[] = [
  { sha: 'fe293c4b', repo: 'remote-claude', subject: 'feat(sidebar): project colour' },
  { sha: '9612583d', repo: 'anvil', subject: 'fix(theme): one ::selection rule' },
]
const commitFacets = (c: Commit): WallRowFacets => ({ title: c.subject, project: c.repo })

beforeEach(() => {
  act(() => store().clear())
})

describe('useWallFilter', () => {
  it('returns everything, identity-preserved, with an empty box', () => {
    const { result } = renderHook(() => useWallFilter(FLEET, ['text', 'project']))
    const out: WallFilterResult<WallRowFacets> = result.current
    expect(out.rows).toBe(FLEET)
    expect(out.matched).toBe(3)
    expect(out.total).toBe(3)
  })

  it('filters on a declared axis and reports matched vs total', () => {
    const { result } = renderHook(() => useWallFilter(FLEET, ['text', 'project', 'context']))
    act(() => store().setRaw('%70'))
    expect(result.current.matched).toBe(1)
    expect(result.current.total).toBe(3)
    expect(result.current.rows[0]?.title).toBe('ceiling copy')
  })

  it('IGNORES an axis the pane did not declare -- the pane stays full', () => {
    const { result } = renderHook(() => useWallFilter(COMMITS, ['text', 'project'], commitFacets))
    act(() => store().setRaw('%70'))
    expect(result.current.matched).toBe(2)
    expect(result.current.total).toBe(2)
    expect(result.current.rows).toBe(COMMITS)
  })

  it('still obeys the axes it did declare', () => {
    const { result } = renderHook(() => useWallFilter(COMMITS, ['text', 'project'], commitFacets))
    act(() => store().setRaw('%70 @anvil'))
    expect(result.current.matched).toBe(1)
    expect(result.current.rows[0]?.sha).toBe('9612583d')
  })

  it('drops nothing when only undeclared axes are typed, however many', () => {
    const { result } = renderHook(() => useWallFilter(COMMITS, ['text'], commitFacets))
    for (const raw of ['%70', '$5', '~1m', '!', '&studio', ':opus', '-#wip']) {
      act(() => store().setRaw(raw))
      expect(result.current.matched, raw).toBe(2)
    }
  })

  it('re-filters when the box changes and un-filters when it clears', () => {
    const { result } = renderHook(() => useWallFilter(FLEET, ['text']))
    act(() => store().setRaw('neon'))
    expect(result.current.matched).toBe(1)
    act(() => store().clear())
    expect(result.current.matched).toBe(3)
    expect(result.current.rows).toBe(FLEET)
  })

  it('holds its result identity across a re-render with no state change', () => {
    const { result, rerender } = renderHook(() => useWallFilter(FLEET, ['text', 'context']))
    act(() => store().setRaw('%70'))
    const first = result.current.rows
    rerender()
    expect(result.current.rows).toBe(first)
  })

  it('survives an inline axes literal without re-filtering every render', () => {
    let filters = 0
    const rows = FLEET.map(r => ({ ...r }))
    const { result, rerender } = renderHook(() =>
      useWallFilter(rows, ['text', 'context'], r => {
        filters++
        return r
      }),
    )
    act(() => store().setRaw('%70'))
    const after = filters
    rerender()
    rerender()
    expect(filters).toBe(after)
    expect(result.current.matched).toBe(1)
  })

  it('honours the hide-managed default only for a pane that declares it', () => {
    const rows: WallRowFacets[] = [{ title: 'seat', managed: true }, { title: 'human' }]
    const declared = renderHook(() => useWallFilter(rows, ['managed']))
    expect(declared.result.current.matched).toBe(1)

    const undeclared = renderHook(() => useWallFilter(rows, ['text']))
    expect(undeclared.result.current.matched).toBe(2)
  })
})

describe('the store lives outside the tree', () => {
  it('keeps the filter across a full unmount and remount of the surface', () => {
    const first = renderHook(() => useWallFilter(FLEET, ['text', 'context']))
    act(() => store().setRaw('%70'))
    expect(first.result.current.matched).toBe(1)

    // inline -> docked -> detached: the whole tree goes away and comes back.
    first.unmount()
    const second = renderHook(() => useWallFilter(FLEET, ['text', 'context']))

    expect(store().raw).toBe('%70')
    expect(second.result.current.matched).toBe(1)
    expect(second.result.current.rows[0]?.title).toBe('ceiling copy')
  })

  it('shares one query across two panes mounted independently', () => {
    const fleet = renderHook(() => useWallFilter(FLEET, ['text', 'project', 'context']))
    const river = renderHook(() => useWallFilter(COMMITS, ['text', 'project'], commitFacets))

    act(() => store().toggleProject('anvil'))
    expect(fleet.result.current.matched).toBe(1)
    expect(river.result.current.matched).toBe(1)

    act(() => store().toggleProject('anvil'))
    expect(fleet.result.current.matched).toBe(3)
    expect(river.result.current.matched).toBe(2)
  })
})
