/**
 * A4: the claims the card makes about the state of the union.
 *
 *  - the prose is LIVE -- it is whatever the route returned, with its own age
 *  - the alert pills map from the fleet union, zeroes dropped
 *  - a project the viewer cannot see contributes no block at all
 *  - the shared filter bites, `{matched}/{total}` rides the count slot
 *  - one fetch serves this pane and A6, not two
 */

import type { SheafProject, SheafResponse } from '@shared/sheaf-types'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { resetWallSheaf } from '../use-wall-sheaf'
import SotuPane from './a4-sotu'
import SheafPane from './a6-sheaf'

const originalFetch = globalThis.fetch
const NOW = 1_700_000_000_000

function project(label: string, sotu?: Record<string, unknown>): SheafProject {
  return {
    projectUri: `claude:///Users/j/${label}`,
    label,
    worktrees: [],
    forest: [],
    totals: { tokens: { input: 0, output: 0, cache: 0 }, cost: { amount: 1, estimated: false } },
    ...(sotu ? { sotu } : {}),
  } as unknown as SheafProject
}

function response(projects: SheafProject[], fleet?: Partial<NonNullable<SheafResponse['sotu']>>): SheafResponse {
  return {
    windowH: 24,
    windowStart: 0,
    windowEnd: NOW,
    generatedAt: NOW,
    totals: {
      projects: projects.length,
      conversations: 1,
      trees: 1,
      tokens: { input: 0, output: 0, cache: 0 },
      cost: { amount: 1, estimated: false },
    },
    projects,
    ...(fleet
      ? {
          sotu: {
            projectsEnabled: 1,
            projectsWithNarrative: 1,
            alerts: [],
            contended: 0,
            atRiskProjects: 0,
            unpushedProjects: 0,
            stalledProjects: 0,
            unmergedProjects: 0,
            filteredProjects: 0,
            ...fleet,
          },
        }
      : {}),
  }
}

function serve(body: SheafResponse): void {
  globalThis.fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch
}

const countSlot = () => document.querySelector('.wall-pane-count')?.textContent ?? ''
const pills = () => [...document.querySelectorAll('.wall-sotu-pill')].map(p => p.textContent)
const blocks = () => [...document.querySelectorAll('.wall-sotu-block')].map(b => b.getAttribute('data-project-uri'))

async function mount(): Promise<void> {
  render(<SotuPane />)
  await waitFor(() => expect(document.querySelector('.wall-sotu-block, .text-fg-faint')).toBeTruthy())
}

beforeEach(() => {
  resetWallSheaf()
  useWallFilterStore.getState().clear()
  serve(
    response([
      project('remote-claude', {
        enabled: true,
        narrative: 'main is RED, two board tests fail on a clean checkout',
        generatedAt: NOW - 9 * 60_000,
        alerts: ['at-risk'],
        contended: 2,
        branches: [{ aheadOrigin: 4 }],
      }),
      project('gate-meet', { enabled: false, alerts: [], contended: 0, branches: [] }),
    ]),
  )
})

afterEach(() => {
  cleanup()
  globalThis.fetch = originalFetch
  vi.restoreAllMocks()
})

describe('A4 state of the union', () => {
  it('renders the LIVE narrative with its own age, not a snapshot', async () => {
    await mount()
    expect(screen.getByText('main is RED, two board tests fail on a clean checkout')).toBeTruthy()
    expect(screen.getByText('9m ago')).toBeTruthy()
  })

  it('carries the project alerts, the contention and the unmerged count', async () => {
    await mount()
    expect(screen.getByText('at-risk')).toBeTruthy()
    expect(screen.getByText('2 contended')).toBeTruthy()
    expect(screen.getByText('4 unmerged')).toBeTruthy()
  })

  it('says why a quiet project is quiet instead of rendering an empty block', async () => {
    await mount()
    expect(screen.getByText('chronicle off for this project')).toBeTruthy()
  })

  it('maps the fleet union to pills and drops the zeroes', async () => {
    serve(
      response([project('p', { enabled: true, narrative: 'x', alerts: [], contended: 0, branches: [] })], {
        atRiskProjects: 1,
        stalledProjects: 3,
        filteredProjects: 2,
      }),
    )
    await mount()
    expect(pills()).toEqual(['1 at-risk', '3 stalled', '2 not shown'])
  })

  it('gives a project the viewer cannot see no block at all', async () => {
    serve(
      response([
        project('visible', { enabled: true, narrative: 'x', alerts: [], contended: 0, branches: [] }),
        project('hidden'),
      ]),
    )
    await mount()
    expect(blocks()).toEqual(['claude:///Users/j/visible'])
  })

  it('renders {matched}/{total}, filters on project, and stays FULL on an axis it never declared', async () => {
    await mount()
    expect(countSlot()).toBe('2/2')

    act(() => {
      useWallFilterStore.getState().setRaw('@gate')
    })
    expect(countSlot()).toBe('1/2')
    expect(blocks()).toEqual(['claude:///Users/j/gate-meet'])

    act(() => {
      useWallFilterStore.getState().setRaw('%80')
    })
    expect(countSlot()).toBe('2/2')
  })

  it('searches the prose, not just the project name', async () => {
    await mount()
    act(() => {
      useWallFilterStore.getState().setRaw('clean checkout')
    })
    expect(blocks()).toEqual(['claude:///Users/j/remote-claude'])
  })

  it('scopes the wall through the store when a project chip is clicked', async () => {
    await mount()
    fireEvent.click(screen.getByTitle('gate-meet'))
    expect(useWallFilterStore.getState().raw).toBe('@gate-meet')
  })

  it('costs ONE request when both panes are on the wall', async () => {
    render(
      <>
        <SheafPane />
        <SotuPane />
      </>,
    )
    await waitFor(() => expect(document.querySelector('.wall-sotu-block')).toBeTruthy())
    expect(vi.mocked(globalThis.fetch).mock.calls).toHaveLength(1)
  })
})
