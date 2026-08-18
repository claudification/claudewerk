import type { EpicInspectResult } from '@shared/protocol'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { OverseerDetail } from './overseer-detail'

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
      digest: '_No digest yet -- the first overseer generation writes it._',
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
      overseerAlive: false,
      maxGenSeen: 0,
      conversations: [
        { id: '1fae5efb', role: 'implementer', cardId: 'dhc-handoff', gen: 0, status: 'active', live: true },
        { id: 'f9985732', role: 'implementer', cardId: 'dhc-mcp-server', gen: 0, status: 'active', live: true },
      ],
    },
    beats: [],
    baton: [
      {
        ts: '2026-08-18T05:51:21.861Z',
        kind: 'dispatch',
        convId: '1fae5efb',
        cardId: 'dhc-handoff',
        body: 'Implementer dispatched at generation 0.',
      },
    ],
    ...over,
  }
}

function show(data: EpicInspectResult | null, extra: Partial<Parameters<typeof OverseerDetail>[0]> = {}) {
  render(<OverseerDetail data={data} error={null} loading={false} nowMs={NOW} onRefresh={() => {}} {...extra} />)
}

afterEach(cleanup)

describe('the run heading', () => {
  it('names the epic, its status and the delivery target', () => {
    show(inspect())

    expect(screen.getByText('duplo-help-connect')).toBeTruthy()
    expect(screen.getByText('armed')).toBeTruthy()
    expect(screen.getByText('merged')).toBeTruthy()
  })

  it('survives a run that has no artifact on disk', () => {
    show(inspect({ run: null }))

    expect(screen.getByText('no run')).toBeTruthy()
    expect(screen.getByText(/of 0 max/)).toBeTruthy()
  })
})

describe('the overseer block -- the thing the first live run hid', () => {
  it('says LOUDLY when no overseer has ever been woken', () => {
    show(inspect())

    expect(screen.getByText(/never woken . lease null/)).toBeTruthy()
    expect(screen.getByText(/nothing planning above them/)).toBeTruthy()
  })

  it('shows the overseer as a seat once one exists', () => {
    const data = inspect()
    data.live.conversations.push({ id: 'aaa', role: 'overseer', gen: 1, status: 'active', live: true })
    show(data)

    expect(screen.queryByText(/never woken/)).toBeNull()
    expect(screen.getByText('OVER')).toBeTruthy()
  })

  it('warns when the broker forgot the run -- armed on disk, not in the sweep', () => {
    const data = inspect()
    data.live.armed = false
    show(data)

    expect(screen.getByText(/broker restarted and forgot it/)).toBeTruthy()
  })
})

describe('seats', () => {
  it('lists the live implementers by card', () => {
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
})

describe('the baton', () => {
  it('renders entries with their card', () => {
    show(inspect())

    expect(screen.getByText(/Implementer dispatched at generation 0/)).toBeTruthy()
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
