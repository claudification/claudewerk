/**
 * The fold that feeds both surfaces. Four claims:
 *
 *  - a card FILED as finished with no promise at all still gets a row (this is
 *    the one that makes the loud table possible; the 70-odd cards THE WALL
 *    closed carry no `promise:` block, and a fold that skipped them would leave
 *    the table structurally empty)
 *  - all five verdicts come back, and `unverifiable` is never folded
 *  - a reverted commit re-opens its card, through the fold, not just in the core
 *  - rows are ordered by how badly they read, not by time
 */

import { describe, expect, it } from 'bun:test'
import type { CommitResolver, CommitStanding } from './promise-ledger'
import { brokenPromises, type PromiseCard, promiseLedgerRows } from './promise-rows'

const PROJECT = 'claude://default/Users/x/alpha'
const META = { resolverBase: 'main', scannedAt: 1_700_000_000_000 }

function card(id: string, front: string, body = 'body'): PromiseCard {
  return { id, text: `---\n${front}\n---\n\n${body}\n` }
}

/** A resolver driven by a table. Anything not in it is UNKNOWN -- nulls, never
 *  a `false`, which is the same rule the real git-backed one follows. */
function resolver(table: Record<string, Partial<CommitStanding>>): CommitResolver {
  return sha => ({ sha, exists: null, onMain: null, ...(table[sha] ?? {}) })
}

const NOTHING = resolver({})
const ALL_LANDED = resolver({ abc1234: { exists: true, onMain: true } })

function fold(cards: PromiseCard[], resolve: CommitResolver = NOTHING) {
  return promiseLedgerRows(PROJECT, cards, resolve, META)
}

describe('the promise fold', () => {
  it('emits a row for a card FILED as finished with no promise block at all', () => {
    // THE CASE THAT MATTERS. This card looks exactly like the 70-odd THE WALL
    // closed: `status: done`, no promise, nothing behind it.
    const ledger = fold([card('wall-thing', 'title: "a thing"\nstatus: done')])

    expect(ledger.rows).toHaveLength(1)
    expect(ledger.rows[0]).toMatchObject({ id: 'wall-thing', status: 'done', verdict: 'not-started', closes: [] })
    expect(brokenPromises(ledger).map(r => r.id)).toEqual(['wall-thing'])
  })

  it('emits NO row for an open card with no promise -- it is `not-started` by definition', () => {
    const ledger = fold([card('just-open', 'title: "open"\nstatus: open')])
    expect(ledger.rows).toHaveLength(0)
    // ...but the denominator still counts it, so a consumer can never read the
    // row set as the board.
    expect(ledger.scanned).toBe(1)
  })

  it('returns all five verdicts, and `unverifiable` is folded into none of them', () => {
    const resolve = resolver({
      landed: { exists: true, onMain: true },
      branchonly: { exists: true, onMain: false },
      fictional: { exists: false, onMain: false },
      // `unchecked` is absent -> nulls -> could not verify.
    })
    const ledger = fold(
      [
        card('a-delivered', 'status: done\npromise:\n  closes: [landed]'),
        card('b-off-main', 'status: done\npromise:\n  closes: [branchonly]'),
        card('c-missing', 'status: done\npromise:\n  closes: [fictional]'),
        card('d-unknown', 'status: done\npromise:\n  closes: [unchecked]'),
        card('e-nothing', 'status: done'),
      ],
      resolve,
    )

    const byId = new Map(ledger.rows.map(row => [row.id, row.verdict]))
    expect(byId.get('a-delivered')).toBe('delivered')
    expect(byId.get('b-off-main')).toBe('not-on-main')
    expect(byId.get('c-missing')).toBe('commit-missing')
    expect(byId.get('d-unknown')).toBe('unverifiable')
    expect(byId.get('e-nothing')).toBe('not-started')
    expect(new Set(byId.values()).size).toBe(5)

    // The loud table takes all four non-delivered ones. `unverifiable` is IN --
    // a done card whose commit nobody could check has not been shown to be
    // finished, and quietly dropping it would be the fold picking the
    // comfortable reading.
    expect(
      brokenPromises(ledger)
        .map(r => r.id)
        .sort(),
    ).toEqual(['b-off-main', 'c-missing', 'd-unknown', 'e-nothing'])
  })

  it('re-opens a reverted promise with nobody having to remember', () => {
    const cards = [card('reverted', 'status: done\npromise:\n  closes: [abc1234]')]
    expect(fold(cards, ALL_LANDED).rows[0].verdict).toBe('delivered')
    expect(brokenPromises(fold(cards, ALL_LANDED))).toHaveLength(0)

    // The revert takes it off main's ancestor path. Same card text, same fold.
    const afterRevert = resolver({ abc1234: { exists: true, onMain: false } })
    expect(fold(cards, afterRevert).rows[0].verdict).toBe('not-on-main')
    expect(brokenPromises(fold(cards, afterRevert)).map(r => r.id)).toEqual(['reverted'])
  })

  it('orders by how badly a row reads, worst first -- never by time', () => {
    const resolve = resolver({
      landed: { exists: true, onMain: true },
      branchonly: { exists: true, onMain: false },
      fictional: { exists: false, onMain: false },
    })
    const ledger = fold(
      [
        card('z-delivered', 'status: done\npromise:\n  closes: [landed]'),
        card('y-nothing', 'status: done'),
        card('x-unknown', 'status: done\npromise:\n  closes: [unchecked]'),
        card('w-off-main', 'status: done\npromise:\n  closes: [branchonly]'),
        card('v-missing', 'status: done\npromise:\n  closes: [fictional]'),
      ],
      resolve,
    )
    expect(ledger.rows.map(r => r.id)).toEqual(['v-missing', 'w-off-main', 'x-unknown', 'y-nothing', 'z-delivered'])
  })

  it('ranks a FILED broken promise above an unfiled one with the same verdict', () => {
    const ledger = fold([
      card('a-still-open', 'status: in-progress\npromise:\n  closes: [unchecked]'),
      card('z-filed-done', 'status: done\npromise:\n  closes: [unchecked]'),
    ])
    // Alphabetically `a-` wins; `done` is the assertion the ledger argues with,
    // so it goes first anyway.
    expect(ledger.rows.map(r => r.id)).toEqual(['z-filed-done', 'a-still-open'])
  })

  it('carries the resolver base through, so "no main branch" is distinguishable', () => {
    const ledger = promiseLedgerRows(PROJECT, [card('x', 'status: done')], NOTHING, {
      resolverBase: null,
      scannedAt: 1,
    })
    expect(ledger.resolverBase).toBeNull()
    expect(ledger.project).toBe(PROJECT)
  })

  it('reads all three `closes:` shapes through the fold, not just the core module', () => {
    const ledger = fold(
      [
        card('inline', 'status: done\npromise:\n  closes: [abc1234]'),
        card('bare', 'status: done\npromise:\n  closes: abc1234'),
        card('list', 'status: done\npromise:\n  closes:\n    - abc1234  # why'),
      ],
      ALL_LANDED,
    )
    expect(ledger.rows.map(r => r.verdict)).toEqual(['delivered', 'delivered', 'delivered'])
    expect(brokenPromises(ledger)).toHaveLength(0)
  })

  it('does not choke on a card with no front matter, or no status key', () => {
    const ledger = promiseLedgerRows(
      PROJECT,
      [
        { id: 'raw', text: 'no front matter here at all\n' },
        // No `status:` -- it cannot be on a lane, so only a promise earns a row.
        card('lane-less', 'title: "orphan"\npromise:\n  closes: []'),
      ],
      NOTHING,
      META,
    )
    expect(ledger.rows.map(r => r.id)).toEqual(['lane-less'])
    expect(ledger.scanned).toBe(2)
  })
})
