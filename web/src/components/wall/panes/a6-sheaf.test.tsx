/**
 * A6: the four claims the card makes about the pane.
 *
 *  - the window toggle re-fetches, and the label follows the RESPONSE
 *  - `clipped` is visible whenever it is non-zero
 *  - the shared filter bites on declared axes and leaves the pane FULL on the
 *    others, with `{matched}/{total}` in the WallPane count slot
 *  - the project chip goes through the filter store's own action
 */

import type { SheafProject, SheafResponse } from '@shared/sheaf-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { resetWallSheaf } from '../use-wall-sheaf'
import SheafPane from './a6-sheaf'

const originalFetch = globalThis.fetch

function project(label: string, cost: number, over: Partial<SheafProject> = {}): SheafProject {
  return {
    projectUri: `claude:///Users/j/${label}`,
    label,
    worktrees: [],
    forest: [{ children: [] }],
    totals: { tokens: { input: 2_100_000, output: 184_000, cache: 0 }, cost: { amount: cost, estimated: false } },
    ...over,
  } as unknown as SheafProject
}

function response(windowH: number, projects: SheafProject[]): SheafResponse {
  return {
    windowH,
    windowStart: 0,
    windowEnd: 1,
    generatedAt: 1,
    totals: {
      projects: projects.length,
      conversations: 63,
      trees: 21,
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 184.3, estimated: false },
    },
    projects,
  }
}

/** A project with nothing to say: no spend, no tokens, no forest, no alerts. */
function quiet(label: string): SheafProject {
  return project(label, 0, {
    forest: [],
    totals: {
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 0, estimated: false },
      convCount: 0,
      treeCount: 0,
    },
  })
}

/** Answer every `/api/sheaf?windowH=N` with the window it was asked for. */
function serve(projectsFor: (windowH: number) => SheafProject[]): void {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
    const windowH = Number(new URL(String(input), 'http://x').searchParams.get('windowH'))
    return new Response(JSON.stringify(response(windowH, projectsFor(windowH))), { status: 200 })
  }) as unknown as typeof fetch
}

async function mount(): Promise<void> {
  render(<SheafPane />)
  await waitFor(() => expect(document.querySelector('.wall-sheaf-row')).toBeTruthy())
}

const countSlot = () => document.querySelector('.wall-pane-count')?.textContent ?? ''
const rowNames = () => [...document.querySelectorAll('.wall-sheaf-name')].map(n => n.textContent)

beforeEach(() => {
  resetWallSheaf()
  useWallFilterStore.getState().clear()
  serve(() => [project('remote-claude', 121.8), project('gate-meet', 19.9)])
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('A6 sheaf', () => {
  it('renders the totals line and a row per project', async () => {
    await mount()
    expect(screen.getByText('$184.30')).toBeTruthy()
    expect(screen.getByText('63')).toBeTruthy()
    expect(rowNames()).toEqual(['remote-claude', 'gate-meet'])
    expect(screen.getAllByText(/2\.1M\s*in \/\s*184k\s*out/)).toHaveLength(2)
  })

  it('switches the window, refetches, and labels the numbers with the window they arrived for', async () => {
    await mount()
    expect(screen.getByText(/24h window/)).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByText('7d'))
    })
    await waitFor(() => expect(screen.getByText(/7d window/)).toBeTruthy())
    expect(vi.mocked(globalThis.fetch).mock.calls.map(c => String(c[0]))).toEqual([
      '/api/sheaf?windowH=24',
      '/api/sheaf?windowH=168',
    ])
  })

  it('shows the clipped count -- silent truncation reads as "that is everything"', async () => {
    serve(() => Array.from({ length: 23 }, (_, i) => project(`p${i}`, 23 - i)))
    await mount()
    expect(screen.getByText('+ 3 lower-cost projects clipped')).toBeTruthy()
  })

  it('says nothing about clipping when nothing was clipped', async () => {
    await mount()
    expect(screen.queryByText(/clipped/)).toBeNull()
  })

  it('renders {matched}/{total} and filters on a declared axis', async () => {
    await mount()
    expect(countSlot()).toBe('2/2')

    act(() => {
      useWallFilterStore.getState().setRaw('@gate')
    })
    expect(countSlot()).toBe('1/2')
    expect(rowNames()).toEqual(['gate-meet'])
  })

  it('filters on $cost -- a sheaf row IS money', async () => {
    await mount()
    act(() => {
      useWallFilterStore.getState().setRaw('$50')
    })
    expect(rowNames()).toEqual(['remote-claude'])
  })

  it('stays FULL under an axis it never declared', async () => {
    await mount()
    act(() => {
      // Context pressure is a conversation facet. A project has none, and this
      // pane never declared the axis, so it must drop nobody.
      useWallFilterStore.getState().setRaw('%80')
    })
    expect(countSlot()).toBe('2/2')
  })

  it('scopes the wall through the store when a project chip is clicked', async () => {
    await mount()
    fireEvent.click(screen.getByTitle('gate-meet'))
    expect(useWallFilterStore.getState().raw).toBe('@gate-meet')
    // Clicking the same chip again clears it -- the store's toggle, not a local one.
    fireEvent.click(screen.getByTitle('gate-meet'))
    expect(useWallFilterStore.getState().raw).toBe('')
  })

  it('drops the projects with nothing to say and says how many it dropped', async () => {
    serve(() => [project('remote-claude', 121.8), quiet('dormant'), quiet('never-touched')])
    await mount()
    expect(rowNames()).toEqual(['remote-claude'])
    expect(screen.getByText('+ 2 quiet')).toBeTruthy()
  })

  it('says nothing about quiet projects when every project earned its row', async () => {
    await mount()
    expect(screen.queryByText(/quiet/)).toBeNull()
  })

  it('recomputes membership on a window switch WITHOUT ever blanking the pane', async () => {
    // 6h sees one busy project; 7d is wide enough that `slow` has spend too.
    let release: () => void = () => {}
    const gate = new Promise<void>(resolve => {
      release = resolve
    })
    globalThis.fetch = vi.fn(async (input: RequestInfo | URL) => {
      const windowH = Number(new URL(String(input), 'http://x').searchParams.get('windowH'))
      const projects = windowH === 168 ? [project('busy', 9), project('slow', 2)] : [project('busy', 4), quiet('slow')]
      if (windowH === 168) await gate
      return new Response(JSON.stringify(response(windowH, projects)), { status: 200 })
    }) as unknown as typeof fetch

    await mount()
    expect(rowNames()).toEqual(['busy'])
    expect(screen.getByText('+ 1 quiet')).toBeTruthy()

    act(() => {
      fireEvent.click(screen.getByText('7d'))
    })
    // MID-SWITCH: the 7d response has not landed. The previous one is still up,
    // so the pane shows the 24h membership rather than flashing empty.
    expect(rowNames()).toEqual(['busy'])
    expect(screen.getByText(/24h window/)).toBeTruthy()

    await act(async () => {
      release()
      await gate
    })
    await waitFor(() => expect(rowNames()).toEqual(['busy', 'slow']))
    expect(screen.queryByText(/quiet/)).toBeNull()
  })

  it('reports a refused route instead of an empty ledger', async () => {
    globalThis.fetch = vi.fn(async () => new Response('nope', { status: 403 })) as unknown as typeof fetch
    render(<SheafPane />)
    await waitFor(() => expect(screen.getByText('sheaf unavailable: sheaf 403')).toBeTruthy())
  })
})
