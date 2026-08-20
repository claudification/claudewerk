/**
 * A7 AS IT RENDERS: the buckets, the two alarms, and the filter contract.
 *
 * The feeds are mocked because all three of them are websockets and an HTTP
 * prime -- what this suite is about is the pane. The fold behind it has its own
 * suite (`runs/run-model.test.ts`) and the action gate has a third
 * (`runs/run-actions.test.tsx`).
 */

import type { EpicActivityEntry, EpicInspectResult } from '@shared/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { act } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import type { UnattendedRow } from './runs/use-unattended-runs'

const NOW = Date.parse('2026-08-19T12:00:00.000Z')
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString()

const feed = vi.hoisted(() => ({ rows: [] as unknown[] }))
vi.mock('./runs/use-unattended-runs', () => ({
  useUnattendedRuns: () => ({ rows: feed.rows, stale: false }),
  useRunClock: () => Date.parse('2026-08-19T12:00:00.000Z'),
}))

const inspect = vi.hoisted(() => ({ data: null as unknown }))
vi.mock('@/components/overseer/use-overseer-inspect', () => ({
  useOverseerInspect: () => ({
    data: inspect.data,
    error: null,
    loading: false,
    fetchedAt: null,
    stale: false,
    refresh: () => {},
  }),
}))

const night = vi.hoisted(() => ({ snapshot: undefined as unknown, decisions: [] as unknown[] }))
vi.mock('@/hooks/use-nightshift', () => ({ useNightshift: () => ({ snapshot: night.snapshot }) }))
vi.mock('@/hooks/use-nightshift-watchdog', () => ({ useNightshiftWatchdog: () => ({ decisions: night.decisions }) }))

import UnattendedRunsPane from './panes/a7-unattended-runs'

const PROJECT = 'claude:///Users/j/remote-claude'

function entry(over: Partial<EpicActivityEntry> = {}): EpicActivityEntry {
  return {
    epicId: 'epic-the-wall',
    project: PROJECT,
    status: 'armed',
    gen: 3,
    maxGens: 40,
    inFlight: 2,
    overseerAlive: true,
    armed: true,
    lastBeatAt: iso(20_000),
    stale: false,
    ...over,
  }
}

function epicRow(over: Partial<EpicActivityEntry> = {}, projectName = 'remote-claude'): UnattendedRow {
  const e = entry(over)
  return {
    kind: 'epic',
    key: `epic ${e.project} ${e.epicId}`,
    project: e.project,
    projectName,
    epicId: e.epicId,
    entry: e,
  }
}

const card = (id: string) => ({ id, title: id, status: 'open' })

function inspectResult(over: Partial<EpicInspectResult> = {}): EpicInspectResult {
  return {
    epicId: 'epic-the-wall',
    project: PROJECT,
    run: null,
    lease: { convId: 'abcdef1234', gen: 4, at: iso(30_000) },
    plan: {
      children: 12,
      dispatch: [card('a')],
      verify: [card('b'), card('c')],
      questions: [],
      heldBack: [],
      waitingOnDeps: [card('g')],
      complete: false,
    },
    live: {
      armed: true,
      inFlight: ['c1', 'c2'],
      settled: [],
      unacknowledged: [],
      overseerAlive: true,
      maxGenSeen: 3,
      conversations: [],
    },
    beats: [],
    baton: [],
    ...over,
  }
}

beforeEach(() => {
  feed.rows = []
  inspect.data = inspectResult()
  night.snapshot = undefined
  night.decisions = []
  useWallFilterStore.getState().clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

describe('the unattended-runs pane', () => {
  it('is quiet when nothing is running unattended', () => {
    render(<UnattendedRunsPane />)
    expect(screen.getByText('nothing is running unattended')).toBeTruthy()
  })

  it('shows the DAG buckets the inspect view computed', () => {
    feed.rows = [epicRow()]
    render(<UnattendedRunsPane />)

    expect(screen.getByText('1 ready')).toBeTruthy()
    expect(screen.getByText('2 in flight')).toBeTruthy()
    expect(screen.getByText('2 awaiting verdict')).toBeTruthy()
    expect(screen.getByText('1 waiting on deps')).toBeTruthy()
    expect(screen.getByText('0 parked')).toBeTruthy()
  })

  it('makes a STALE OVERSEER LEASE unmistakable -- the alarm this pane exists for', () => {
    feed.rows = [epicRow()]
    inspect.data = inspectResult({ lease: { convId: 'deadbeef99', gen: 4, at: iso(45 * 60_000) } })
    render(<UnattendedRunsPane />)

    const line = document.querySelector('.wall-run-overseer-bad')
    expect(line).toBeTruthy()
    expect(line?.textContent).toContain('STALE LEASE')
    expect(line?.textContent).toContain('deadbeef')
  })

  it('marks a run with no recent beat as STALLED, with the age', () => {
    feed.rows = [epicRow({ stale: true, lastBeatAt: iso(4 * 60_000) })]
    render(<UnattendedRunsPane />)

    expect(screen.getByText('STALLED -- no beat for 4m')).toBeTruthy()
    expect(document.querySelector('.wall-run[data-stalled]')).toBeTruthy()
  })

  it('prints WHY NOTHING MOVED when the run is armed and nothing is ready', () => {
    feed.rows = [epicRow()]
    const plan = inspectResult().plan
    inspect.data = inspectResult({ plan: { ...plan!, dispatch: [], idleReason: 'every card waits on a dep' } })
    render(<UnattendedRunsPane />)

    expect(screen.getByText('every card waits on a dep')).toBeTruthy()
  })

  it('renders a night run as a queue and a watchdog verdict, not as a fake DAG', () => {
    feed.rows = [
      {
        kind: 'nightshift',
        key: 'n',
        project: PROJECT,
        projectName: 'remote-claude',
        runId: '2026-08-19',
        liveWorkers: 2,
      },
    ]
    night.snapshot = {
      run: { runId: '2026-08-19', window: '01:00-07:00' },
      tasks: [{ status: 'queued' }, { status: 'queued' }, { status: 'running' }, { status: 'done' }],
    }
    night.decisions = [{ verdict: 'warn', reason: 'task 003 approaching the idle cap', at: NOW - 60_000 }]
    render(<UnattendedRunsPane />)

    expect(screen.getByText('2 running')).toBeTruthy()
    expect(screen.getByText('2 queued')).toBeTruthy()
    expect(screen.getByText('1 settled')).toBeTruthy()
    expect(screen.getByText(/watchdog warn · 1m ago · task 003 approaching the idle cap/)).toBeTruthy()
  })

  it('renders {matched}/{total} and stays FULL for an axis it does not declare', () => {
    feed.rows = [epicRow(), epicRow({ epicId: 'epic-ting-voice', project: 'claude:///g' }, 'gate-meet')]
    render(<UnattendedRunsPane />)
    expect(screen.getByText('2/2 · 2 armed')).toBeTruthy()

    // `%80` is context pressure -- an epic run has none, so the pane must not blank.
    act(() => useWallFilterStore.getState().setRaw('%80'))
    expect(screen.getByText('2/2 · 2 armed')).toBeTruthy()

    // A project scope IS an axis it declares.
    act(() => useWallFilterStore.getState().setRaw('@gate-meet'))
    expect(screen.getByText('1/2 · 1 armed')).toBeTruthy()
  })

  it('stays FULL under the default hide-managed rule -- every row here IS managed', () => {
    // The grammar hides machine-dispatched rows by default. This pane must not
    // declare that axis: if it did, an empty filter box would empty the pane.
    feed.rows = [epicRow()]
    render(<UnattendedRunsPane />)
    expect(screen.getByText('1/1 · 1 armed')).toBeTruthy()
  })
})
