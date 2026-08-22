import type { EpicInspectResult } from '@shared/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { WerkMasterDetail } from './werk-master-detail'

const PROJECT = 'claude://default/Users/jonas/projects/remote-help'
const NOW = Date.parse('2026-08-18T06:00:00.000Z')

function inspect(over: Partial<EpicInspectResult> = {}): EpicInspectResult {
  return {
    epicId: 'duplo-help-connect',
    project: PROJECT,
    run: {
      epicId: 'duplo-help-connect',
      project: PROJECT,
      cadence: 'now',
      status: 'armed',
      gen: 0,
      target: 'merged',
      dryGens: 0,
      maxGens: 40,
      plan: true,
      planned: true,
      concurrency: 3,
      digest: '_No digest yet -- the first werk-master generation writes it._',
    } as unknown as EpicInspectResult['run'],
    lease: null,
    plan: {
      children: 19,
      dispatch: [{ id: 'dhc-auth-bridge', title: 'Auth bridge', status: 'open' }],
      verify: [],
      questions: [],
      heldBack: [],
      waitingOnDeps: [{ id: 'dhc-widget-embed', title: 'Widget', status: 'open', waitingOn: ['dhc-mcp-server'] }],
      complete: false,
    },
    live: {
      armed: true,
      inFlight: ['dhc-handoff', 'dhc-mcp-server'],
      settled: [],
      unacknowledged: [],
      werkMasterAlive: false,
      maxGenSeen: 0,
      conversations: [
        { id: '1fae5efb', role: 'werk-worker', cardId: 'dhc-handoff', gen: 0, status: 'active', live: true },
        { id: 'f9985732', role: 'werk-worker', cardId: 'dhc-mcp-server', gen: 0, status: 'active', live: true },
      ],
    },
    beats: [],
    baton: [
      {
        ts: '2026-08-18T05:51:21.861Z',
        kind: 'dispatch',
        convId: '1fae5efb',
        cardId: 'dhc-handoff',
        body: 'WerkWorker dispatched at generation 0.',
      },
    ],
    ...over,
  }
}

function show(data: EpicInspectResult | null, extra: Partial<Parameters<typeof WerkMasterDetail>[0]> = {}) {
  render(<WerkMasterDetail data={data} error={null} loading={false} nowMs={NOW} onRefresh={() => {}} {...extra} />)
}

afterEach(cleanup)

describe('the run heading', () => {
  /**
   * The pill prints the DERIVED vitality, never `run.status`. This fixture is
   * `status: 'armed'` with two live werk-workers, which is a run that is
   * genuinely working -- and the point of the change is that the reverse case
   * (`status: 'running'` with nothing alive) can no longer print RUNNING.
   */
  it('names the epic, what it is actually doing, and the delivery target', () => {
    show(inspect())

    expect(screen.getByText('duplo-help-connect')).toBeTruthy()
    expect(screen.getByText('RUNNING')).toBeTruthy()
    expect(screen.getByText(/2 seat\(s\) working/)).toBeTruthy()
    expect(screen.getByText('merged')).toBeTruthy()
  })

  it('a live status with no seat and no armed entry is NOT reported as running', () => {
    const data = inspect()
    data.live.inFlight = []
    data.live.armed = false
    data.live.conversations = []
    show(data)

    expect(screen.queryByText('RUNNING')).toBeNull()
    expect(screen.getByText('STALLED')).toBeTruthy()
  })

  it('survives a run that has no artifact on disk', () => {
    show(inspect({ run: null }))

    expect(screen.getByText('NO RUN')).toBeTruthy()
    expect(screen.getByText(/of 0 max/)).toBeTruthy()
  })

  /**
   * WAITING IS NOT IDLE. `runVitality` reads seats, beats and the armed set --
   * none of which change when a run is armed for 02:00 -- so it says ARMED and
   * means it, and a pane that stopped there is one a reader cannot tell apart
   * from a dead run. The appointment is printed beside the pill, with the offset
   * it was set in and a countdown, because the broker's clock is UTC and the
   * reader's is not.
   */
  it('says a run is WAITING on an appointment rather than leaving the pill to imply idle', () => {
    const data = inspect()
    data.live.inFlight = []
    data.live.conversations = []
    // 19:00 +07:00 is 12:00Z, and `NOW` is 06:00Z.
    if (data.run) data.run.cadence = ['at:2026-08-18T19:00:00+07:00']
    show(data)

    expect(screen.getByText(/WAITING -- waiting until 2026-08-18T19:00:00\+07:00 \(in 6 hours\)/)).toBeTruthy()
  })

  it('says nothing about an appointment that has already passed', () => {
    const data = inspect()
    if (data.run) data.run.cadence = ['at:2026-08-18T05:00:00Z']
    show(data)

    expect(screen.queryByText(/WAITING --/)).toBeNull()
  })
})

describe('the werk-master block -- the thing the first live run hid', () => {
  it('says LOUDLY when no werk-master has ever been woken', () => {
    show(inspect())

    expect(screen.getByText(/never woken . lease null/)).toBeTruthy()
    expect(screen.getByText(/nothing planning above them/)).toBeTruthy()
  })

  it('shows the werk-master as a seat once one exists', () => {
    const data = inspect()
    data.live.conversations.push({ id: 'aaa', role: 'werk-master', gen: 1, status: 'active', live: true })
    show(data)

    expect(screen.queryByText(/never woken/)).toBeNull()
    expect(screen.getByText('MSTR')).toBeTruthy()
  })

  it('warns when the broker forgot the run -- armed on disk, not in the sweep', () => {
    const data = inspect()
    data.live.armed = false
    show(data)

    expect(screen.getByText(/broker restarted and forgot it/)).toBeTruthy()
  })
})

describe('seats', () => {
  it('lists the live werk-workers by card', () => {
    show(inspect())

    expect(screen.getByText('dhc-handoff')).toBeTruthy()
    expect(screen.getByText('dhc-mcp-server')).toBeTruthy()
    expect(screen.getByText('2 / 3')).toBeTruthy()
  })

  it('says so plainly when nothing is working', () => {
    const data = inspect()
    data.live.conversations = []
    show(data)

    expect(screen.getByText(/No seat is working right now/)).toBeTruthy()
  })
})

describe('the DAG', () => {
  it('renders the ready lane and what a blocked card waits on', () => {
    show(inspect())

    expect(screen.getByText('dhc-auth-bridge')).toBeTruthy()
    expect(screen.getByText('dhc-widget-embed')).toBeTruthy()
    // The waiting lane names its blocker with an arrow, distinct from the seat
    // row that carries the same card id.
    expect(screen.getByText('← dhc-mcp-server')).toBeTruthy()
    expect(screen.getByText('19 cards')).toBeTruthy()
  })

  it('leads with idleReason, the line worth reading first', () => {
    const data = inspect()
    if (data.plan) data.plan.idleReason = 'every ready card is at the concurrency ceiling'
    show(data)

    expect(screen.getByText(/concurrency ceiling/)).toBeTruthy()
  })

  it('handles an epic no card claims', () => {
    show(inspect({ plan: null }))

    expect(screen.getByText(/No card on the board carries or claims this epic/)).toBeTruthy()
  })

  /**
   * A FAILED BOARD READ REACHES THIS PANE AS `plan: null` TOO, and until
   * `boardError` existed the two were one state: a sentinel timeout printed "no
   * card carries this epic" about an epic with 31 children on disk (2026-08-22).
   * "The epic has no children" is the sentence that justifies aborting a run.
   */
  it('says the board was NOT READ instead of claiming no card carries the epic', () => {
    show(inspect({ plan: null, boardError: 'sentinel timed out' }))

    expect(screen.getByText(/BOARD NOT READ/)).toBeTruthy()
    expect(screen.getByText(/unknown, not empty/)).toBeTruthy()
    expect(screen.queryByText(/No card on the board carries or claims this epic/)).toBeNull()
  })

  it('withholds the board-derived stats rather than reporting them as zero', () => {
    show(inspect({ plan: null, boardError: 'sentinel timed out' }))

    for (const label of ['DONE', 'READY', 'BLOCKED']) {
      expect(screen.getByText(label).previousSibling?.textContent).toBe('-')
    }
  })
})

describe('the baton', () => {
  it('renders entries with their card', () => {
    show(inspect())

    expect(screen.getByText(/WerkWorker dispatched at generation 0/)).toBeTruthy()
  })

  it('reports an empty baton rather than rendering nothing', () => {
    show(inspect({ baton: [] }))

    expect(screen.getByText(/The baton is empty/)).toBeTruthy()
  })
})

describe('empty and error states', () => {
  it('asks you to pick a run when none is selected', () => {
    show(null)

    expect(screen.getByText(/Pick a run on the left/)).toBeTruthy()
  })

  it('surfaces a read failure instead of a blank pane', () => {
    show(null, { error: 'sentinel offline' })

    expect(screen.getByText(/sentinel offline/)).toBeTruthy()
  })

  it('does not blank the pane on a refresh -- only the first load', () => {
    show(null, { loading: true })

    expect(screen.getByText(/Reading the run/)).toBeTruthy()
  })
})
