/**
 * P3 with the promise ledger wired through the REAL hook and the real board op,
 * with only the socket faked. The claims:
 *
 *  - every row on the pane carries one of the five verdicts
 *  - the loud table lands on the pane, and survives a filter that empties the
 *    ledger underneath it
 *  - a card the fold never mentioned reads `not started`, but only once its
 *    project has ANSWERED -- before that it is `could not verify`
 *  - a sentinel that REFUSES the op does not render as a clean board
 *  - the pane declares no wall feed and does no wall-frame work for any of it
 */

import type { PromiseLedger } from '@shared/promise-rows'
import type { CardMove } from '@shared/protocol'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { applyCardLedgerFrame, resetCardLedger } from '@/hooks/card-ledger-feed'
import { resetPromiseLedgerCache } from '@/hooks/use-promise-ledger'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { useCardLedgerViewStore } from './card-ledger-view'
import CardLedgerPane from './p3-card-ledger'

const sendBoardOp = vi.fn()
vi.mock('@/hooks/project-task-wire', async importOriginal => {
  const actual = await importOriginal<typeof import('@/hooks/project-task-wire')>()
  return { ...actual, sendBoardOp: (...args: unknown[]) => sendBoardOp(...args) }
})

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const ALPHA = 'claude://default/Users/x/alpha'

function move(over: Partial<CardMove> = {}): CardMove {
  return {
    id: 'a-card',
    project: ALPHA,
    title: 'a card',
    from: 'in-review',
    to: 'done',
    ts: NOW - 60_000,
    ...over,
  }
}

function ledger(rows: PromiseLedger['rows']): PromiseLedger {
  return { project: ALPHA, rows, scanned: rows.length, resolverBase: 'main', scannedAt: NOW }
}

function promise(id: string, verdict: PromiseLedger['rows'][number]['verdict'], status = 'done') {
  return {
    id,
    status,
    title: id,
    agreed: null,
    conversation: null,
    session: null,
    asked: null,
    preLedger: false,
    inferred: false,
    closes: [],
    commits: [],
    verdict,
  }
}

const chips = () => [...document.querySelectorAll('.wall-ledger-row .wall-verdict')]
const brokenRows = () => [...document.querySelectorAll('.wall-broken-row')]

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  vi.setSystemTime(NOW)
  resetCardLedger()
  resetPromiseLedgerCache()
  sendBoardOp.mockReset()
  useWallFilterStore.getState().clear()
  useCardLedgerViewStore.setState({ view: 'all' })
})

afterEach(() => {
  cleanup()
  resetCardLedger()
  resetPromiseLedgerCache()
  vi.useRealTimers()
})

describe('P3 + the promise ledger', () => {
  it('carries a verdict on every row and puts the broken ones in the loud table', async () => {
    sendBoardOp.mockResolvedValue({
      ok: true,
      promises: ledger([promise('filed-empty', 'not-started'), promise('shipped', 'delivered')]),
    })
    applyCardLedgerFrame([move({ id: 'filed-empty' }), move({ id: 'shipped', ts: NOW - 120_000 })], { full: true })
    render(<CardLedgerPane />)

    await waitFor(() => expect(chips()).toHaveLength(2))
    expect(chips().map(el => el.getAttribute('data-verdict'))).toEqual(['not-started', 'delivered'])

    // `delivered` is NOT in the loud table; `not-started` on a filed card is.
    expect(brokenRows()).toHaveLength(1)
    expect(screen.getByText('filed-empty')).toBeTruthy()
    // It asked the board op, not a wall feed.
    expect(sendBoardOp).toHaveBeenCalledWith(ALPHA, 'promises')
  })

  it('reads a card the fold never mentioned as `not started` -- once its project answered', async () => {
    sendBoardOp.mockResolvedValue({ ok: true, promises: ledger([promise('other', 'delivered')]) })
    applyCardLedgerFrame([move({ id: 'never-mentioned', to: 'in-review' })], { full: true })
    render(<CardLedgerPane />)

    await waitFor(() => expect(chips()[0]?.getAttribute('data-verdict')).toBe('not-started'))
    // An unmentioned card is not filed, so it is not an accusation.
    expect(brokenRows()).toHaveLength(0)
  })

  it('says `could not verify` -- never `not started` -- before the project has answered', async () => {
    // A promise that never settles: the pane is mounted, the ask is out, and no
    // answer has come back. Reading that silence as `not started` would be the
    // pane inventing a verdict out of its own latency.
    sendBoardOp.mockReturnValue(new Promise(() => {}))
    applyCardLedgerFrame([move()], { full: true })
    render(<CardLedgerPane />)

    await waitFor(() => expect(chips()).toHaveLength(1))
    expect(chips()[0]?.getAttribute('data-verdict')).toBe('unverifiable')
    expect(chips()[0]?.getAttribute('data-tone')).toBe('unknown')
  })

  it('does NOT render a refused sentinel as a clean board', async () => {
    // The `useWallPins` scar, transplanted: a sentinel that does not know the op
    // REPLIES with ok:false, and `resp.promises ?? []` would read that as "no
    // broken promises here" -- the most dangerous wrong answer this feature has.
    sendBoardOp.mockResolvedValue({ ok: false, error: 'unknown op: promises' })
    applyCardLedgerFrame([move()], { full: true })
    render(<CardLedgerPane />)

    await waitFor(() => expect(screen.getByText(/could not check every project/)).toBeTruthy())
    expect(screen.getByText(/unknown op: promises/)).toBeTruthy()
    expect(document.querySelector('.wall-broken')).toBeTruthy()
  })

  it('keeps the loud table up when a filter empties the ledger underneath it', async () => {
    sendBoardOp.mockResolvedValue({ ok: true, promises: ledger([promise('filed-empty', 'not-started')]) })
    applyCardLedgerFrame([move({ id: 'filed-empty' })], { full: true })
    render(<CardLedgerPane />)
    await waitFor(() => expect(brokenRows()).toHaveLength(1))

    // A query nothing matches. The moves go; the accusation does not -- a card
    // filed as finished with nothing behind it does not stop being one because
    // somebody typed in the box.
    useWallFilterStore.getState().setRaw('@nowhere')
    await waitFor(() => expect(screen.getByText('no move matches the filter')).toBeTruthy())
    expect(brokenRows()).toHaveLength(1)
  })

  it('asks each project ONCE, not once per row', async () => {
    sendBoardOp.mockResolvedValue({ ok: true, promises: ledger([]) })
    applyCardLedgerFrame(
      [move({ id: 'one' }), move({ id: 'two', ts: NOW - 2000 }), move({ id: 'three', ts: NOW - 3000 })],
      { full: true },
    )
    render(<CardLedgerPane />)

    await waitFor(() => expect(sendBoardOp).toHaveBeenCalled())
    expect(sendBoardOp.mock.calls.filter(call => call[1] === 'promises')).toHaveLength(1)
  })
})
