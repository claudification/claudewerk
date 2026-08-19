/**
 * A2: the four claims the card makes about the burn clock.
 *
 *  - every number traces to a feed, and a feed that did not arrive is a DASH
 *  - the two splits render separately and are never summed
 *  - the cap state is honest when no cap is set
 *  - the filter is the shared one: declared axes bite, undeclared axes leave the
 *    pane FULL, `{matched}/{total}` rides the count slot, and the project chip
 *    goes through the store's action
 */

import { projectIdentityKey } from '@shared/project-uri'
import type { WallFrame } from '@shared/wall'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useConversationsStore } from '@/hooks/use-conversations'
import { applyWallFrame, resetWallFrames } from '@/hooks/wall-frame-store'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import BurnPane from './a2-burn'

const RC = 'claude://default/Users/j/projects/remote-claude'
const ANVIL = 'claude://default/Users/j/projects/anvil'

/** An hour key inside today, so `costSince(localMidnight)` sees it. */
function thisHour(): string {
  const d = new Date()
  d.setMinutes(0, 0, 0)
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z')
}

const HOURLY = [
  { hour: thisHour(), projectUri: RC, costUsd: 10 },
  { hour: thisHour(), projectUri: RC, costUsd: 5 },
  { hour: thisHour(), projectUri: ANVIL, costUsd: 3 },
  { hour: thisHour(), projectUri: '', costUsd: 1 },
]

const FEATURES = [
  { key: 'recap', costUsd: 4 },
  { key: 'voice', costUsd: 1 },
]

interface FeedOverrides {
  hourly?: unknown
  summary?: unknown
  openrouter?: unknown
  /** Routes whose fetch should 403, the way an admin-only route does. */
  forbid?: string[]
}

function stubFeeds(over: FeedOverrides = {}) {
  const forbid = over.forbid ?? []
  const body = (url: string): unknown => {
    if (url.includes('/hourly')) return over.hourly ?? HOURLY
    if (url.includes('/summary')) return over.summary ?? { totalCostUsd: 15_500 }
    return over.openrouter ?? { byFeature: FEATURES }
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (forbid.some(f => url.includes(f))) return { ok: false, status: 403, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body(url) }
    }),
  )
}

async function mount(over: FeedOverrides = {}) {
  stubFeeds(over)
  const view = render(<BurnPane />)
  await waitFor(() => expect(document.querySelectorAll('.wall-burn-split')).toHaveLength(2))
  return view
}

function countSlot(): string {
  return document.querySelector('.wall-pane-count')?.textContent ?? ''
}

function splitTotals(): string[] {
  return [...document.querySelectorAll('.wall-burn-split-total')].map(e => e.textContent ?? '')
}

function projectRows(): string[] {
  const split = document.querySelectorAll('.wall-burn-split')[0]
  return [...(split?.querySelectorAll('.wall-burn-name') ?? [])].map(e => e.textContent ?? '')
}

beforeEach(() => {
  resetWallFrames()
  useWallFilterStore.getState().clear()
  useConversationsStore.setState({
    // Labels come from the panel's own project settings, exactly as P1 resolves
    // them -- so a project is called the same thing on every pane of the wall.
    projectSettings: {
      [projectIdentityKey(RC)]: { label: 'remote-claude' },
      [projectIdentityKey(ANVIL)]: { label: 'anvil' },
    },
    globalSettings: {},
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('A2 burn -- the feeds', () => {
  it('folds the hourly feed into today and the 30d summary into the month tile', async () => {
    await mount()
    const tiles = [...document.querySelectorAll('.wall-burn-tile-val')].map(e => e.textContent)
    expect(tiles).toEqual(['$19.00', '$15.5k'])
  })

  it('DASHES a feed that never arrived instead of showing a plausible zero', async () => {
    await mount({ forbid: ['/hourly', '/summary'] })
    const tiles = [...document.querySelectorAll('.wall-burn-tile-val')].map(e => e.textContent)
    expect(tiles).toEqual(['--', '--'])
    expect(screen.getByText('no cost feed')).toBeTruthy()
  })

  it('says WHICH feed is missing -- one 403 does not blank the other split', async () => {
    await mount({ forbid: ['/openrouter'] })
    expect(screen.getByText('no openrouter feed')).toBeTruthy()
    expect(projectRows()).toEqual(['remote-claude', 'anvil', 'unattributed'])
  })

  it('starts the rate as a dash, because nothing has been observed yet', async () => {
    await mount()
    expect(document.querySelector('.wall-burn-rate')?.textContent).toBe('--/h')
    expect(document.querySelector('.wall-burn-rate')?.getAttribute('data-measuring')).toBe('true')
  })

  it('names the unattributed bucket rather than folding it into a real project', async () => {
    await mount()
    expect(screen.getByText('unattributed')).toBeTruthy()
  })
})

describe('A2 burn -- the two splits', () => {
  it('gives each split its OWN total and never a summed one', async () => {
    await mount()
    expect(splitTotals()).toEqual(['$19.00', '$5.00'])
    // $24 is the number this pane must never produce.
    expect(screen.queryByText('$24.00')).toBeNull()
  })

  it('scales each bar against its own split, so a $4 feature can be its 80%', async () => {
    await mount()
    const bars = [...document.querySelectorAll('.wall-burn-bar i')].map(e => (e as HTMLElement).style.width)
    // projects: 15/19, 3/19, 1/19 -- openrouter: 4/5, 1/5
    expect(bars.at(-2)).toBe('80%')
    expect(bars[0]).toBe(`${(15 / 19) * 100}%`)
  })
})

describe('A2 burn -- the cap', () => {
  it('says NO CAP SET, in the alarm tone, when none is configured', async () => {
    await mount()
    expect(screen.getByText('NO CAP SET')).toBeTruthy()
    expect(document.querySelector('.wall-burn-tile[data-alarm]')).toBeTruthy()
  })

  it('reports the share against a cap that IS set, and drops the alarm', async () => {
    useConversationsStore.setState({ globalSettings: { monthlySpendCapUsd: 31_000 } })
    await mount()
    expect(screen.getByText('50% of $31.0k')).toBeTruthy()
    expect(document.querySelector('.wall-burn-tile[data-alarm]')).toBeNull()
  })

  it('raises the alarm again when the cap is BREACHED', async () => {
    useConversationsStore.setState({ globalSettings: { monthlySpendCapUsd: 1000 } })
    await mount()
    expect(document.querySelector('.wall-burn-tile[data-alarm]')).toBeTruthy()
  })
})

describe('A2 burn -- the shared filter', () => {
  it('renders {matched}/{total} in the pane count slot', async () => {
    await mount()
    expect(countSlot()).toBe('3/3 · 24h')

    act(() => {
      useWallFilterStore.getState().setRaw('@anvil')
    })
    expect(countSlot()).toBe('1/3 · 24h')
    expect(projectRows()).toEqual(['anvil'])
  })

  it('re-totals the split it filtered, so the header matches the rows under it', async () => {
    await mount()
    act(() => {
      useWallFilterStore.getState().setRaw('@anvil')
    })
    expect(splitTotals()[0]).toBe('$3.00')
  })

  it('applies the `$` cost axis, which a spend bar genuinely has', async () => {
    await mount()
    act(() => {
      useWallFilterStore.getState().setRaw('$2')
    })
    expect(projectRows()).toEqual(['remote-claude', 'anvil'])
  })

  it('stays FULL under an axis it never declared', async () => {
    await mount()
    act(() => {
      // Context pressure is a per-conversation fact; a spend bar has no facet for
      // it, the pane does not declare the axis, so it must drop nobody.
      useWallFilterStore.getState().setRaw('%80')
    })
    expect(countSlot()).toBe('3/3 · 24h')
  })

  it('leaves the OPENROUTER split full under `@project` -- infrastructure is not a project', async () => {
    await mount()
    act(() => {
      useWallFilterStore.getState().setRaw('@anvil')
    })
    const openrouter = document.querySelectorAll('.wall-burn-split')[1]
    expect([...(openrouter?.querySelectorAll('.wall-burn-name') ?? [])].map(e => e.textContent)).toEqual([
      'recap',
      'voice',
    ])
  })

  it('sends a project click through the STORE action, not a local handler', async () => {
    await mount()
    const anvil = screen.getByText('anvil').closest('button')
    expect(anvil).toBeTruthy()
    fireEvent.click(anvil as Element)
    expect(useWallFilterStore.getState().raw).toBe('@anvil')
    // Clicking the same project again clears the scope -- the store's toggle, not
    // a second implementation of it in this pane.
    fireEvent.click(screen.getByText('anvil').closest('button') as Element)
    expect(useWallFilterStore.getState().raw).toBe('')
  })
})

describe('A2 burn -- the live rate', () => {
  it('measures the rate from wall-frame cost deltas, with no fetch at all', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      await mount()
      const frame = (seq: number, at: number, costUsd: number): WallFrame => ({
        type: 'wall_frame',
        seq,
        at,
        full: seq === 1,
        coalesced: 1,
        pulse: { changed: [{ id: 'c1', project: 'p', title: 't', status: 'active', lastActivity: at, costUsd }] },
      })

      const t0 = Date.now()
      act(() => {
        applyWallFrame(frame(1, t0, 1))
      })
      // Keep the channel alive across the two minutes -- a silent gap is the
      // reconnect case, and the fold deliberately reseeds through those.
      for (let seq = 2; seq <= 4; seq++) {
        await act(async () => {
          await vi.advanceTimersByTimeAsync(30_000)
        })
        act(() => {
          applyWallFrame(frame(seq, t0 + (seq - 1) * 30_000, 1))
        })
      }
      // Two minutes in, the same conversation has billed one more dollar:
      // $1 in 2 minutes = $30/h, measured, never extrapolated.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_000)
      })
      act(() => {
        applyWallFrame(frame(5, t0 + 120_000, 2))
      })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(1100)
      })

      // ~$30/h, not exactly: the divisor is time OBSERVED, and it keeps growing
      // on the local clock after the last frame -- which is the point. An idle
      // fleet's rate decays instead of freezing at its last burst.
      const shown = Number(document.querySelector('.wall-burn-rate')?.textContent?.replace(/[$/h]/g, ''))
      expect(shown).toBeGreaterThan(28)
      expect(shown).toBeLessThanOrEqual(30)
    } finally {
      vi.useRealTimers()
    }
  })
})
