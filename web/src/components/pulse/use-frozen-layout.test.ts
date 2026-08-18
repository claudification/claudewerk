import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { PulseBand } from '@/lib/pulse/bands'
import { parsePulseQuery } from '@/lib/pulse/filter'
import { useFrozenLayout } from './use-frozen-layout'
import type { PulseFleet, PulseRow } from './use-pulse-fleet'

/**
 * Pulse sorts by recency, which is right for a glance and hostile to a click:
 * WORKING churns every second or two, so a row you are reaching for slides out
 * from under the pointer. Jonas: "otherwise I can't flick things."
 */
const row = (id: string, band: PulseBand = 'working', ageMs = 1_000): PulseRow =>
  ({
    id,
    conversation: { id } as PulseRow['conversation'],
    band,
    title: id,
    project: 'remote-claude',
    action: 'working',
    ageMs,
  }) as PulseRow

const ZERO: Record<PulseBand, number> = { needs: 0, working: 0, done: 0, idle: 0, expired: 0 }

function fleet(groups: Array<{ band: PulseBand; rows: PulseRow[] }>): PulseFleet {
  return {
    groups,
    flat: groups.flatMap(g => g.rows),
    totals: ZERO,
    expired: [],
    hidden: 0,
    managedHidden: 0,
    query: parsePulseQuery(''),
    isEmpty: true,
  }
}

const ids = (f: PulseFleet, band: PulseBand = 'working') =>
  (f.groups.find(g => g.band === band)?.rows ?? []).map(r => r.id)

describe('useFrozenLayout', () => {
  it('passes the fleet straight through while unfrozen', () => {
    const f = fleet([{ band: 'working', rows: [row('a'), row('b')] }])
    const { result } = renderHook(() => useFrozenLayout(f, false))
    expect(result.current).toBe(f)
  })

  it('HOLDS the order once frozen, even as recency reshuffles it', () => {
    const first = fleet([{ band: 'working', rows: [row('a'), row('b'), row('c')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })

    rerender({ f: first, frozen: true })
    expect(ids(result.current)).toEqual(['a', 'b', 'c'])

    // c just did something, so live order flips it to the front.
    const churned = fleet([{ band: 'working', rows: [row('c'), row('a'), row('b')] }])
    rerender({ f: churned, frozen: true })
    expect(ids(result.current)).toEqual(['a', 'b', 'c'])
  })

  it('keeps row CONTENT live while positions are held', () => {
    const first = fleet([{ band: 'working', rows: [row('a', 'working', 1_000)] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    const aged = fleet([{ band: 'working', rows: [row('a', 'working', 90_000)] }])
    rerender({ f: aged, frozen: true })
    expect(result.current.groups[0].rows[0].ageMs).toBe(90_000)
  })

  it('APPENDS arrivals rather than inserting them at the top', () => {
    // Inserting at the top would shift every held row down by one -- the exact
    // thing that makes a click miss.
    const first = fleet([{ band: 'working', rows: [row('a'), row('b')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    const withNew = fleet([{ band: 'working', rows: [row('new'), row('a'), row('b')] }])
    rerender({ f: withNew, frozen: true })
    expect(ids(result.current)).toEqual(['a', 'b', 'new'])
  })

  it('drops rows that disappeared without disturbing the rest', () => {
    const first = fleet([{ band: 'working', rows: [row('a'), row('b'), row('c')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    const gone = fleet([{ band: 'working', rows: [row('a'), row('c')] }])
    rerender({ f: gone, frozen: true })
    expect(ids(result.current)).toEqual(['a', 'c'])
  })

  it('drops a band that empties out entirely', () => {
    const first = fleet([
      { band: 'working', rows: [row('a')] },
      { band: 'idle', rows: [row('z', 'idle')] },
    ])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    rerender({ f: fleet([{ band: 'working', rows: [row('a')] }]), frozen: true })
    expect(result.current.groups.map(g => g.band)).toEqual(['working'])
  })

  it('takes a band that appears while frozen', () => {
    const first = fleet([{ band: 'working', rows: [row('a')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    const withNeeds = fleet([
      { band: 'needs', rows: [row('urgent', 'needs')] },
      { band: 'working', rows: [row('a')] },
    ])
    rerender({ f: withNeeds, frozen: true })
    expect(result.current.groups.map(g => g.band).sort()).toEqual(['needs', 'working'])
  })

  it('keeps flat in sync with the held groups', () => {
    const first = fleet([{ band: 'working', rows: [row('a'), row('b')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })
    rerender({ f: fleet([{ band: 'working', rows: [row('b'), row('a')] }]), frozen: true })
    expect(result.current.flat.map(r => r.id)).toEqual(['a', 'b'])
  })

  it('RE-SNAPSHOTS on the next open rather than resurrecting a stale order', () => {
    const first = fleet([{ band: 'working', rows: [row('a'), row('b')] }])
    const { result, rerender } = renderHook(({ f, frozen }) => useFrozenLayout(f, frozen), {
      initialProps: { f: first, frozen: false },
    })
    rerender({ f: first, frozen: true })

    const later = fleet([{ band: 'working', rows: [row('b'), row('a')] }])
    rerender({ f: later, frozen: false })
    rerender({ f: later, frozen: true })
    expect(ids(result.current)).toEqual(['b', 'a'])
  })
})
