/**
 * S2 as it actually renders.
 *
 * The four things a screenshot would not catch:
 *  - a STALE reading never appears as a bare number;
 *  - a not-authed profile says so instead of drawing a 0% bar;
 *  - the throttle line is there and a profile over it is marked;
 *  - the reset countdown says the zone, the local clock AND the relative -- and
 *    still says the right thing across a DST boundary.
 */

import { formatAbsolute, viewerTimeZone } from '@shared/format-when'
import type { WallFrame, WallPlanSample } from '@shared/wall'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWallFrame, resetWallFrames } from '@/hooks/wall-frame-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import PlanUsagePane from '../panes/s2-plan-usage'

// `useConversationsStore` is here for `useWallFilter`, not for S2: the shared
// hook resolves the `^workspace` axis out of the sidebar's project order, and it
// asks for that whether or not this pane declared the axis. A selector over an
// empty state answers "no workspaces", which is the right answer for a pane
// whose rows are per-account and have no project at all.
vi.mock('@/hooks/use-conversations', () => ({
  wsSend: vi.fn(),
  useConversationsStore: (select: (state: unknown) => unknown) => select({}),
}))

const T0 = Date.parse('2026-08-19T12:00:00.000Z')

function sample(over: Partial<WallPlanSample> = {}): WallPlanSample {
  return { profile: 'default', node: 'studio', utilization: 40, at: T0, state: 'ok', ...over }
}

function feed(plan: WallPlanSample[], at: number = T0): void {
  const frame: WallFrame = { type: 'wall_frame', seq: 1, at, full: true, coalesced: 1, plan }
  applyWallFrame(frame)
}

function row(profile: string): HTMLElement | null {
  return document.querySelector(`.wall-plan-row[data-profile="${profile}"]`)
}

beforeEach(() => {
  resetWallFrames()
  useWallFilterStore.getState().clear()
  vi.setSystemTime(T0)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('S2 plan usage', () => {
  it('says there is no feed rather than drawing an empty chart', () => {
    render(<PlanUsagePane />)
    expect(screen.getByText('no feed yet')).toBeTruthy()
  })

  it('draws one line per profile with the throttle line over them', () => {
    feed([sample({ profile: 'a', utilization: 30 }), sample({ profile: 'b', utilization: 91 })])
    render(<PlanUsagePane />)

    expect(document.querySelectorAll('.wall-plan-line')).toHaveLength(2)
    expect(screen.getByTestId('wall-plan-throttle')).toBeTruthy()
    // Worst first, and marked -- "which account first" is the top row.
    expect(document.querySelector('.wall-plan-row')?.getAttribute('data-profile')).toBe('b@studio')
    expect(row('b@studio')?.hasAttribute('data-over')).toBe(true)
    expect(row('a@studio')?.hasAttribute('data-over')).toBe(false)
  })

  it('breaks the line where the broker declared a hole, rather than drawing across it', () => {
    // The two readings are 90s apart -- close enough that the pane's own
    // time-gap heuristic would happily join them. `gapBefore` says the broker
    // was away in between, so there is no measurement to join.
    feed([sample({ at: T0 - 120_000, utilization: 30 }), sample({ at: T0 - 30_000, utilization: 80, gapBefore: true })])
    render(<PlanUsagePane />)

    const d = document.querySelector('.wall-plan-line')?.getAttribute('d') ?? ''
    expect(d.match(/M/g)).toHaveLength(2)
  })

  it('draws one unbroken line when nothing declared a hole', () => {
    feed([sample({ at: T0 - 120_000, utilization: 30 }), sample({ at: T0 - 30_000, utilization: 80 })])
    render(<PlanUsagePane />)

    const d = document.querySelector('.wall-plan-line')?.getAttribute('d') ?? ''
    expect(d.match(/M/g)).toHaveLength(1)
  })

  it('renders a stale reading with its age, never the number alone', () => {
    feed([sample({ utilization: 62, stale: true, polledAt: T0 - 40 * 60_000 })])
    render(<PlanUsagePane />)

    const el = row('default@studio')
    expect(el?.hasAttribute('data-stale')).toBe(true)
    expect(el?.querySelector('.wall-plan-pct')?.textContent).toBe('62%')
    expect(el?.querySelector('.wall-plan-stale')?.textContent).toBe('40 minutes ago')
  })

  it('renders a not-authed profile as such, with no bar to misread', () => {
    feed([sample({ profile: 'work', utilization: 0, state: 'unauthed' })])
    render(<PlanUsagePane />)

    const el = row('work@studio')
    expect(el?.querySelector('.wall-plan-pct')?.textContent).toBe('not authed')
    expect(el?.querySelector('.wall-plan-bar')).toBeNull()
    expect(document.querySelector('.wall-plan-line')?.getAttribute('d')).toBe('')
  })

  it('names the failure when the probe was rejected', () => {
    feed([sample({ utilization: 0, state: 'error', errorKind: 'http' })])
    render(<PlanUsagePane />)

    expect(row('default@studio')?.querySelector('.wall-plan-pct')?.textContent).toBe('probe rejected')
  })

  it('renders the reset as relative PLUS the local clock PLUS the zone', () => {
    feed([sample({ resetsAt: T0 + 2 * 3_600_000 })])
    render(<PlanUsagePane />)

    const reset = row('default@studio')?.querySelector('.wall-plan-reset')
    const when = reset?.querySelector('.wall-plan-when')?.textContent ?? ''

    expect(reset?.querySelector('b')?.textContent).toBe('resets in 2h')
    // Never a bare time: a clock AND the zone it belongs to, whatever zone the
    // machine running this happens to be in.
    expect(when).toMatch(/\d{2}:\d{2}/)
    expect(when).toContain(viewerTimeZone())
  })

  it('counts matched/total in the pane header and stays full for an axis it does not declare', () => {
    feed([sample({ profile: 'a' }), sample({ profile: 'b' })])
    const { rerender } = render(<PlanUsagePane />)
    expect(document.querySelector('.wall-pane-count')?.textContent).toBe('2/2 · 5h')

    useWallFilterStore.getState().setRaw('&studio a')
    rerender(<PlanUsagePane />)
    expect(document.querySelector('.wall-pane-count')?.textContent).toBe('1/2 · 5h')

    // `%70` is context pressure -- a per-conversation fact this pane never
    // declared. It must leave the pane FULL, not empty it.
    useWallFilterStore.getState().setRaw('%70')
    rerender(<PlanUsagePane />)
    expect(document.querySelector('.wall-pane-count')?.textContent).toBe('2/2 · 5h')
  })

  it('blames the FILTER when the filter emptied it, not the missing feed', () => {
    feed([sample({ profile: 'a' }), sample({ profile: 'b' })])
    const { rerender } = render(<PlanUsagePane />)

    useWallFilterStore.getState().setRaw('zzzznothingmatchesthis')
    rerender(<PlanUsagePane />)

    // The header still says there are two lines. The body has to agree with it:
    // "no feed yet" beside a `0/2` is the pane calling itself a liar.
    expect(document.querySelector('.wall-pane-count')?.textContent).toBe('0/2 · 5h')
    expect(screen.getByText('no profile matches the filter')).toBeTruthy()
    expect(screen.queryByText('no feed yet')).toBeNull()
  })
})

describe('S2 countdown across a DST boundary', () => {
  // Europe/Berlin springs forward at 02:00 local on 2026-03-29. A reset three
  // real hours after "now" lands at 05:00 local, not 04:00 -- the wall clock
  // skipped an hour and the countdown did not.
  const beforeSpring = Date.parse('2026-03-29T00:30:00.000Z') // 01:30 Berlin, CET
  const reset = beforeSpring + 3 * 3_600_000 // 03:30 UTC = 05:30 Berlin, CEST

  beforeEach(() => {
    vi.setSystemTime(beforeSpring)
  })

  it('counts real elapsed hours, not wall-clock ones', () => {
    feed([sample({ at: beforeSpring, resetsAt: reset })], beforeSpring)
    render(<PlanUsagePane />)

    expect(row('default@studio')?.querySelector('.wall-plan-reset b')?.textContent).toBe('resets in 3h')
  })

  it('shows the clock the reader will actually see -- 05:30, not 04:30', () => {
    // The zone is passed explicitly, so this pins the rendering rather than the
    // zone the test machine happens to be in.
    expect(formatAbsolute(reset, 'Europe/Berlin', beforeSpring)).toBe('Sun 29 Mar, 05:30')
    expect(formatAbsolute(beforeSpring, 'Europe/Berlin', beforeSpring)).toBe('Sun 29 Mar, 01:30')
  })
})
