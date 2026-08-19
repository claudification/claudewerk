/**
 * P3's model: the two things the pane can get quietly wrong.
 *
 *  - ORDER. Newest first, by the move's own timestamp, whatever order the feed
 *    happened to hand the batch over in.
 *  - IDENTITY. One card crossing four lanes is four rows, not one row that keeps
 *    overwriting itself.
 */

import type { CardMove } from '@shared/protocol'
import { describe, expect, it } from 'vitest'
import { cardLedgerRows } from './card-ledger'

const NOW = new Date(2026, 7, 20, 14, 0, 0).getTime()
const MIN = 60_000
const ALPHA = 'claude://default/Users/x/alpha'

function move(over: Partial<CardMove> = {}): CardMove {
  return {
    id: 'wall-pane-card-ledger',
    project: ALPHA,
    title: 'the card ledger pane',
    from: 'in-progress',
    to: 'in-review',
    priority: 'medium',
    ts: NOW - 5 * MIN,
    ...over,
  }
}

const look = (uri: string) => ({ projectName: uri.split('/').pop() ?? uri })

describe('cardLedgerRows', () => {
  it('orders newest first even when the batch arrives out of order', () => {
    const rows = cardLedgerRows(
      [
        move({ id: 'mid', ts: NOW - 5 * MIN }),
        move({ id: 'oldest', ts: NOW - 60 * MIN }),
        move({ id: 'newest', ts: NOW - MIN }),
      ],
      look,
      NOW,
    )
    expect(rows.map(r => r.id)).toEqual(['newest', 'mid', 'oldest'])
  })

  it('breaks a timestamp tie on the id, so one board write renders stably', () => {
    const batch = [move({ id: 'zulu', ts: NOW }), move({ id: 'alpha', ts: NOW }), move({ id: 'mike', ts: NOW })]
    expect(cardLedgerRows(batch, look, NOW).map(r => r.id)).toEqual(['alpha', 'mike', 'zulu'])
    // ...and the same batch shuffled sorts to the same order.
    expect(cardLedgerRows([...batch].reverse(), look, NOW).map(r => r.id)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('keys each CROSSING, not each card -- a card moving twice is two rows', () => {
    const rows = cardLedgerRows(
      [
        move({ id: 'c', from: 'open', to: 'in-progress', ts: NOW - 20 * MIN }),
        move({ id: 'c', from: 'in-progress', to: 'done', ts: NOW - MIN }),
      ],
      look,
      NOW,
    )
    expect(rows).toHaveLength(2)
    expect(new Set(rows.map(r => r.key)).size).toBe(2)
  })

  it('marks only a move whose DESTINATION is done', () => {
    const rows = cardLedgerRows(
      [
        move({ id: 'closing', to: 'done' }),
        move({ id: 'reopened', from: 'done', to: 'open' }),
        move({ id: 'archived', to: 'archived' }),
      ],
      look,
      NOW,
    )
    expect(rows.filter(r => r.isDone).map(r => r.id)).toEqual(['closing'])
  })

  it('measures age from the passed clock, never from Date.now()', () => {
    const [row] = cardLedgerRows([move({ ts: NOW - 90 * MIN })], look, NOW)
    expect(row?.ageMs).toBe(90 * MIN)
    expect(row?.age).toBe('1h')
  })

  it('never reports a negative age for a move stamped in the future', () => {
    const [row] = cardLedgerRows([move({ ts: NOW + 10 * MIN })], look, NOW)
    expect(row?.ageMs).toBe(0)
    expect(row?.age).toBe('0s')
  })

  it('resolves the project through the caller-supplied look, per row', () => {
    const rows = cardLedgerRows(
      [move({ id: 'a' }), move({ id: 'b', project: 'claude://default/Users/x/beta' })],
      look,
      NOW,
    )
    expect(rows.map(r => r.projectName).sort()).toEqual(['alpha', 'beta'])
  })

  it('carries the epic MEMBERSHIP through and filters nothing on it', () => {
    // Epic cards are dropped at the sentinel, so `epic` here is the parent id.
    // A row that dropped its own membership would leave the epic hue with
    // nothing to key off.
    const rows = cardLedgerRows([move({ epic: 'epic-the-wall' }), move({ id: 'loose' })], look, NOW)
    expect(rows).toHaveLength(2)
    expect(rows.find(r => r.epic)?.epic).toBe('epic-the-wall')
  })

  it('drops an absent priority instead of inventing one', () => {
    const [row] = cardLedgerRows([move({ priority: undefined })], look, NOW)
    expect(row?.priority).toBeUndefined()
  })
})
