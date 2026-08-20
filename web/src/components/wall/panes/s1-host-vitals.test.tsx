/**
 * S1: the three claims the card makes about the pane.
 *
 *  - a stopped reporter GREYS with its last-seen age and shows no live numbers
 *  - the filter is the shared one: declared axes bite, undeclared axes leave the
 *    pane FULL, and `{matched}/{total}` rides the WallPane count slot
 *  - the sparkline draws the broker's ring, so a cold open is not a flat line
 */

import type { WallFrame, WallHostVitals } from '@shared/wall'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyWallFrame, resetWallFrames } from '@/hooks/wall-frame-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import HostVitalsPane from './s1-host-vitals'

const NOW = 1_700_000_000_000

function host(over: Partial<WallHostVitals> = {}): WallHostVitals {
  return {
    nodeId: 'n-studio',
    alias: 'studio',
    at: NOW,
    cpuPct: 42,
    memPct: 61,
    diskPct: 99,
    load1: 3.2,
    cores: 12,
    conversations: 7,
    cpuHistory: [10, 20, 30, 42],
    ...over,
  }
}

function frame(hosts: WallHostVitals[]): WallFrame {
  return { type: 'wall_frame', seq: 1, at: NOW, full: true, coalesced: hosts.length, hosts }
}

function mount(hosts: WallHostVitals[]) {
  const view = render(<HostVitalsPane />)
  act(() => {
    applyWallFrame(frame(hosts))
  })
  return view
}

function row(nodeId: string): HTMLElement | null {
  return document.querySelector(`[data-node="${nodeId}"]`)
}

function countSlot(): string {
  return document.querySelector('.wall-pane-count')?.textContent ?? ''
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  resetWallFrames()
  useWallFilterStore.getState().clear()
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

describe('S1 host vitals', () => {
  it('renders a live node with its numbers', () => {
    mount([host()])
    expect(row('n-studio')?.dataset.stale).toBeUndefined()
    expect(screen.getByText('studio')).toBeTruthy()
    expect(screen.getByText('7 conv')).toBeTruthy()
    expect(screen.getByText(/3\.20/)).toBeTruthy()
    expect(document.querySelectorAll('polyline')).toHaveLength(1)
  })

  it('greys a stopped reporter with its last-seen age and NO live numbers', () => {
    mount([host({ at: NOW - 180_000 })])
    const el = row('n-studio')
    expect(el).toBeTruthy()
    expect(el?.dataset.stale).toBe('true')
    expect(screen.getByText('last seen 3m ago')).toBeTruthy()
    // The percentages are gone, not merely dimmed -- a green 42 next to "3m ago"
    // is the phantom the card names.
    expect(screen.queryByText('42')).toBeNull()
    expect(screen.queryByText('7 conv')).toBeNull()
  })

  it('qualifies a stale meter tooltip -- the bar keeps its shape, not its claim', () => {
    mount([host({ at: NOW - 360_000 })])
    const meters = [...document.querySelectorAll('[data-node] [title^="cpu"], [data-node] [title^="dsk"]')]
    expect(meters.map(m => m.getAttribute('title'))).toEqual([
      'cpu 42% when last seen, 6m ago',
      'dsk 99% when last seen, 6m ago',
    ])
  })

  it('crosses into stale on the CLOCK, with no frame arriving to say so', async () => {
    mount([host()])
    expect(row('n-studio')?.dataset.stale).toBeUndefined()

    await act(async () => {
      vi.setSystemTime(NOW + 60_000)
      await vi.advanceTimersByTimeAsync(1100)
    })
    expect(row('n-studio')?.dataset.stale).toBe('true')
  })

  it('renders {matched}/{total} in the pane count slot', () => {
    mount([host(), host({ nodeId: 'n-nas', alias: 'nas' })])
    expect(countSlot()).toBe('2/2')

    act(() => {
      useWallFilterStore.getState().setRaw('&nas')
    })
    expect(countSlot()).toBe('1/2')
    expect(row('n-nas')).toBeTruthy()
    expect(row('n-studio')).toBeNull()
  })

  it('stays FULL under an axis it never declared', () => {
    mount([host(), host({ nodeId: 'n-nas', alias: 'nas' })])
    // `%80` is context pressure -- a host row has no such facet, and the pane
    // does not declare the axis, so it must drop nobody.
    act(() => {
      useWallFilterStore.getState().setRaw('%80')
    })
    expect(countSlot()).toBe('2/2')
    expect(row('n-studio')).toBeTruthy()
  })

  it('distinguishes "nothing reporting" from "nothing matched"', () => {
    const view = render(<HostVitalsPane />)
    expect(screen.getByText('no node reporting')).toBeTruthy()

    act(() => {
      applyWallFrame(frame([host()]))
      useWallFilterStore.getState().setRaw('&nowhere')
    })
    expect(screen.getByText('no node matches the filter')).toBeTruthy()
    view.unmount()
  })

  it('copies the whole vitals line, not one number', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    mount([host()])

    const button = screen.getByLabelText('Copy studio vitals')
    fireEvent.click(button)
    expect(writeText).toHaveBeenCalledWith('studio  cpu 42%  ram 61%  disk 99%  load 3.20/12  convs 7  sampled 0s ago')
    await waitFor(() => expect(button.getAttribute('data-copy-state')).toBe('copied'))
  })

  it('says the series is still filling rather than drawing a fake flatline', () => {
    mount([host({ cpuHistory: [42] })])
    expect(screen.getByText('filling')).toBeTruthy()
    expect(document.querySelectorAll('polyline')).toHaveLength(0)
  })
})
