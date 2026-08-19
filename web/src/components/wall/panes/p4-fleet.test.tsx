/**
 * P4: the claims the card makes about the pane.
 *
 *  - a tile with no feed behind it shows a DASH, never a plausible number
 *  - the sparkline updates on its own tick without dragging the pane with it
 *  - the shared filter: declared axes bite, undeclared axes leave the pane FULL,
 *    and `{matched}/{total}` rides the WallPane count slot
 */

import type { WallFleetCounters, WallFrame } from '@shared/wall'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { recordTokenSample } from '@/hooks/token-flow-store'
import { applyWallFrame, resetWallFrames } from '@/hooks/wall-frame-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { RATE_BUCKET_MS } from '@/lib/wall/fleet-rate'
import FleetPane from './p4-fleet'

const NOW = 1_700_000_040_000

const COUNTERS: WallFleetCounters = {
  conversations: 19,
  active: 4,
  idle: 12,
  blocked: 3,
  projects: 5,
  hosts: 3,
}

function frame(fleet: WallFleetCounters): WallFrame {
  return { type: 'wall_frame', seq: 1, at: NOW, full: true, coalesced: 1, fleet }
}

function tile(label: string): HTMLElement | null {
  return document.querySelector(`[data-kpi="${label}"]`)
}

function valueOf(label: string): string {
  return tile(label)?.querySelector('.wall-kpi-val')?.textContent ?? ''
}

function countSlot(): string {
  return document.querySelector('.wall-pane-count')?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  resetWallFrames()
  useWallFilterStore.getState().clear()
  // The 24h tile is the only thing on this pane that fetches. Left unresolved by
  // default so the cold, unknown state is what the tests see unless they say so.
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise(() => {})),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

describe('P4 fleet', () => {
  it('dashes every tile that has no feed behind it yet', () => {
    render(<FleetPane />)
    // No ring samples, no wall frame, no resolved fetch: three unknowns.
    expect(valueOf('TOKENS/MIN')).toBe('—')
    expect(valueOf('TOKENS 24H')).toBe('—')
    expect(valueOf('HOSTS UP')).toBe('—')
    expect(tile('HOSTS UP')?.dataset.unknown).toBe('true')
    expect(screen.getByText('no frame yet')).toBeTruthy()
  })

  it('never dresses an absent round-trip feed as a number', () => {
    render(<FleetPane />)
    // ws-stats measures throughput, so the socket rate is real and 0 is honest.
    // The round trip has no probe anywhere on this wire, so it gets the dash.
    expect(valueOf('WS')).toBe('0/s')
    expect(screen.getByText('— ms rtt (no probe)')).toBeTruthy()
  })

  it('counts hosts and their conversations off the one wall frame', () => {
    render(<FleetPane />)
    act(() => {
      applyWallFrame(frame(COUNTERS))
    })
    expect(valueOf('HOSTS UP')).toBe('3')
    expect(screen.getByText('19 conversations')).toBeTruthy()
    expect(tile('HOSTS UP')?.dataset.unknown).toBeUndefined()
  })

  it('draws no sparkline until the ring has something to draw', () => {
    render(<FleetPane />)
    expect(document.querySelector('.wall-kpi-spark')).toBeNull()
  })

  it('fills the rate tile and its sparkline off the ring, on the ring tick alone', async () => {
    render(<FleetPane />)
    act(() => {
      recordTokenSample({
        ts: NOW - RATE_BUCKET_MS,
        sentinelId: 's1',
        profile: 'work',
        model: 'opus',
        input: 600,
        output: 400,
        cacheRead: 0,
        cacheWrite: 0,
      })
    })
    // No wall frame and no fetch resolve in between: the only thing that moves
    // is the token ring's own coalesced ~1 Hz notify, which is a module-level
    // interval installed at import and therefore a REAL one.
    await waitFor(() => expect(valueOf('TOKENS/MIN')).toBe('500'), { timeout: 3_000 })
    expect(document.querySelector('.wall-kpi-spark svg')).toBeTruthy()
    // The tiles that did not feed off that tick are untouched, still unknown.
    expect(valueOf('HOSTS UP')).toBe('—')
    expect(valueOf('TOKENS 24H')).toBe('—')
  })

  it('renders {matched}/{total} in the pane count slot', () => {
    render(<FleetPane />)
    expect(countSlot()).toBe('4/4')

    act(() => {
      useWallFilterStore.getState().setRaw('tokens')
    })
    expect(countSlot()).toBe('2/4')
    expect(tile('TOKENS/MIN')).toBeTruthy()
    expect(tile('HOSTS UP')).toBeNull()
  })

  it('stays FULL under an axis it never declared', () => {
    render(<FleetPane />)
    // A fleet counter has no project, no context pressure and no cost facet, so
    // none of those axes are declared and none of them may empty this pane.
    for (const raw of ['@remote-claude', '%80', '$5']) {
      act(() => {
        useWallFilterStore.getState().setRaw(raw)
      })
      expect(countSlot()).toBe('4/4')
      expect(tile('WS')).toBeTruthy()
    }
  })

  it('says so when the filter matched no tile, instead of rendering an empty grid', () => {
    render(<FleetPane />)
    act(() => {
      useWallFilterStore.getState().setRaw('zzz-nothing')
    })
    expect(countSlot()).toBe('0/4')
    expect(screen.getByText('no tile matches the filter')).toBeTruthy()
  })

  it('sums the 24h total from the server window, in + out', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        ok: true,
        json: async () => ({
          window: '1d',
          from: NOW - 86_400_000,
          to: NOW,
          bucketMs: 1_200_000,
          groupBy: 'global',
          buckets: [
            {
              bucketStart: NOW - 1_200_000,
              sentinelId: 's1',
              profile: 'work',
              inputTokens: 1_000_000,
              outputTokens: 200_000,
              cacheReadTokens: 90_000_000,
              cacheWriteTokens: 5_000,
              samples: 12,
            },
          ],
        }),
      })),
    )
    render(<FleetPane />)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    // 1.2M moved. The 90M of cache reads are NOT spend and must not appear here.
    expect(valueOf('TOKENS 24H')).toBe('1.2M')
  })
})
