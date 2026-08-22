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

// `asked` is what makes "a dimmed row costs nothing" testable: an inspect is a
// sentinel round trip, a board read and a DAG plan, so a run in the not-running
// tail must never appear in this list.
const inspect = vi.hoisted(() => ({ data: null as unknown, asked: [] as string[] }))
vi.mock('@/components/werk-master/use-werk-master-inspect', () => ({
  useWerkMasterInspect: (_project: string, epicId: string) => {
    if (!inspect.asked.includes(epicId)) inspect.asked.push(epicId)
    return {
      data: inspect.data,
      error: null,
      loading: false,
      fetchedAt: null,
      stale: false,
      refresh: () => {},
    }
  },
}))

const night = vi.hoisted(() => ({ snapshot: undefined as unknown, decisions: [] as unknown[], asked: [] as string[] }))
vi.mock('@/hooks/use-nightshift', () => ({
  useNightshift: (project: string) => {
    if (!night.asked.includes(project)) night.asked.push(project)
    return { snapshot: night.snapshot }
  },
}))
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
    werkMasterAlive: true,
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
      werkMasterAlive: true,
      maxGenSeen: 3,
      conversations: [],
    },
    beats: [],
    baton: [],
    ...over,
  }
}

function nightRow(runId: string, liveWorkers: number, project = PROJECT): UnattendedRow {
  return {
    kind: 'nightshift',
    key: `night ${project} ${runId}`,
    project,
    projectName: 'remote-claude',
    runId,
    liveWorkers,
  }
}

beforeEach(() => {
  feed.rows = []
  inspect.data = inspectResult()
  inspect.asked = []
  night.snapshot = undefined
  night.decisions = []
  night.asked = []
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

  it('makes a STALE WERK-MASTER LEASE unmistakable -- the alarm this pane exists for', () => {
    feed.rows = [epicRow()]
    inspect.data = inspectResult({ lease: { convId: 'deadbeef99', gen: 4, at: iso(45 * 60_000) } })
    render(<UnattendedRunsPane />)

    const line = document.querySelector('.wall-run-werk-master-bad')
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
    feed.rows = [nightRow('2026-08-19', 2)]
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
    expect(screen.getByText('2/2 · 2 live')).toBeTruthy()

    // `%80` is context pressure -- an epic run has none, so the pane must not blank.
    act(() => useWallFilterStore.getState().setRaw('%80'))
    expect(screen.getByText('2/2 · 2 live')).toBeTruthy()

    // A project scope IS an axis it declares.
    act(() => useWallFilterStore.getState().setRaw('@gate-meet'))
    expect(screen.getByText('1/2 · 1 live')).toBeTruthy()
  })

  it('stays FULL under the default hide-managed rule -- every row here IS managed', () => {
    // The grammar hides machine-dispatched rows by default. This pane must not
    // declare that axis: if it did, an empty filter box would empty the pane.
    feed.rows = [epicRow()]
    render(<UnattendedRunsPane />)
    expect(screen.getByText('1/1 · 1 live')).toBeTruthy()
  })
})

/**
 * THE CARD'S CLAIM: one liveness test, live rows first, the rest DEMOTED rather
 * than dropped, each carrying the reason it stopped.
 *
 * `epic-the-wall` sat `paused` for nine generations while an epic waited behind
 * it and nothing on any surface said so. Hiding it (O1) institutionalises that;
 * a bare count (O3) hides the reason, which is the only field that turns a stale
 * row into an action. So the assertions here are about ORDER and REASON, and the
 * one that matters most is that a paused run is still on the pane at all.
 */
describe('A7 liveness: what renders, and in what order', () => {
  /** The rows the pane actually put on screen, top to bottom, as
   *  `LABEL name` -- one string per row so ORDER is a single assertion. */
  function rendered(): string[] {
    return [...document.querySelectorAll('.wall-run')].map(el => {
      const tag = el.querySelector('.wall-run-tag')?.textContent ?? ''
      const name = el.querySelector('.wall-run-name, .wall-run-name-static')?.textContent ?? ''
      return `${tag} ${name}`.trim()
    })
  }

  it('ranks paused and aborted runs BELOW the live one, and never drops them', () => {
    feed.rows = [
      epicRow({ epicId: 'epic-the-wall', status: 'paused' }),
      epicRow({ epicId: 'epic-the-wall-ii' }),
      epicRow({ epicId: 'epic-ting-voice', status: 'aborted' }),
    ]
    render(<UnattendedRunsPane />)

    // The live one first even though it arrived second: the partition ranks, it
    // does not re-sort, so the two dead ones keep their incoming order below it.
    expect(rendered()).toEqual(['RUNNING epic-the-wall-ii', 'PAUSED epic-the-wall', 'ABORTED epic-ting-voice'])
    expect(screen.getByText('3/3 · 1 live')).toBeTruthy()
  })

  it('puts exactly the not-live rows in the dimmed tail, under a heading that counts', () => {
    feed.rows = [
      epicRow({ epicId: 'epic-the-wall-ii' }),
      epicRow({ epicId: 'epic-the-wall', status: 'paused' }),
      epicRow({ epicId: 'epic-ting-voice', status: 'aborted' }),
    ]
    render(<UnattendedRunsPane />)

    const tail = document.querySelector('.wall-run-tail-section')
    expect(tail).toBeTruthy()
    expect(screen.getByText('not running · 2')).toBeTruthy()
    expect([...(tail?.querySelectorAll('.wall-run-tail') ?? [])].length).toBe(2)
    // ...and the live row is NOT in it.
    expect(tail?.textContent).not.toContain('epic-the-wall-ii')
  })

  it('gives every dimmed row its REASON -- paused, aborted and expired are three different situations', () => {
    feed.rows = [
      epicRow({ epicId: 'epic-the-wall', status: 'paused' }),
      epicRow({ epicId: 'epic-ting-voice', status: 'aborted' }),
      nightRow('2026-08-14', 0),
    ]
    render(<UnattendedRunsPane />)

    expect(screen.getByText('Paused. Nothing dispatches until RESUME re-arms it.')).toBeTruthy()
    expect(screen.getByText('This run was aborted. It will not beat again unless it is re-armed.')).toBeTruthy()
    expect(screen.getByText(/Every worker has exited/)).toBeTruthy()
  })

  it('costs nothing for a run that is not running -- no inspect, no night snapshot', () => {
    feed.rows = [
      epicRow({ epicId: 'epic-the-wall-ii' }),
      epicRow({ epicId: 'epic-the-wall', status: 'paused' }),
      nightRow('2026-08-14', 0),
    ]
    render(<UnattendedRunsPane />)

    expect(inspect.asked).toEqual(['epic-the-wall-ii'])
    expect(night.asked).toEqual([])
  })

  it('calls a night run whose workers have all exited EXPIRED instead of vanishing it', () => {
    // The old feed dropped these in the hook, where the only possible answer was
    // "no row" -- a second liveness test, disagreeing with the epic half.
    //
    // THIS TEST DOES NOT PIN THAT DELETION, and reads as if it does: the feed is
    // mocked above, so all it proves is what the pane does with a hand-built
    // `liveWorkers: 0`. The half that proves the feed can still PRODUCE one lives
    // in `runs/use-unattended-runs.test.ts`, against a real conversation store.
    feed.rows = [nightRow('2026-08-14', 0)]
    render(<UnattendedRunsPane />)

    expect(rendered()).toEqual(['EXPIRED 2026-08-14'])
    expect(screen.getByText('1/1 · 0 live')).toBeTruthy()
  })

  it('keeps a STALLED run in the LIVE section -- it is the alarm, not the archive', () => {
    feed.rows = [epicRow({ stale: true, lastBeatAt: iso(4 * 60_000) })]
    render(<UnattendedRunsPane />)

    expect(document.querySelector('.wall-run-tail-section')).toBeNull()
    expect(screen.getByText('STALLED -- no beat for 4m')).toBeTruthy()
    expect(screen.getByText('1/1 · 1 live')).toBeTruthy()
  })
})
