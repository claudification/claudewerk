/**
 * THE CARD LEDGER's durable half.
 *
 * The one thing this store exists to make true: a broker that is killed and
 * re-opened still shows P3. Everything else here is a way that could quietly
 * stop being true -- a ring that persists but never refills, a replayed batch
 * counted twice, an optional field arriving back as `null`, a retention sweep
 * that eats live history.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CardMove } from '../shared/protocol'
import { CARD_LEDGER_CAP, cardLedgerSize, clearCardLedger, readCardLedger, recordCardMoves } from './card-ledger-ring'
import {
  CARD_MOVE_RETENTION_MS,
  closeCardLedgerStore,
  initCardLedgerStore,
  persistCardMoves,
  readPersistedCardMoves,
  sweepCardMoves,
} from './card-ledger-store'
import { rehydrateWallRings } from './wall/rehydrate'

/** Relative to the real clock: `initCardLedgerStore()` sweeps against
 *  `Date.now()`, so a hard-coded epoch would be swept before the first assert. */
const NOW = Date.now()
const SEC = 1_000

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'card-ledger-store-test-'))
  clearCardLedger()
  initCardLedgerStore(dir)
})
afterEach(() => {
  closeCardLedgerStore()
  clearCardLedger()
  rmSync(dir, { recursive: true, force: true })
})

function move(id: string, over: Partial<CardMove> = {}): CardMove {
  return { id, project: 'claude://default/repo', title: id, from: 'open', to: 'done', ts: NOW, ...over }
}

/** Simulate the broker dying and coming back on the same cache dir: the process
 *  memory goes with it, the directory does not. */
function restart(): void {
  closeCardLedgerStore()
  clearCardLedger()
  initCardLedgerStore(dir)
}

describe('round trip', () => {
  // THE card's acceptance test: write moves, restart, read them back.
  test('card moves survive a broker restart and refill the ring', () => {
    recordCardMoves([move('alpha', { ts: NOW - 3 * SEC }), move('beta', { ts: NOW - 2 * SEC })])
    recordCardMoves([move('gamma', { ts: NOW - SEC })])
    expect(readCardLedger().map(m => m.id)).toEqual(['gamma', 'beta', 'alpha'])

    restart()
    expect(cardLedgerSize()).toBe(0) // the ring really did die

    rehydrateWallRings()

    expect(readCardLedger().map(m => m.id)).toEqual(['gamma', 'beta', 'alpha'])
  })

  test('every field of a move survives the trip, and absent stays absent', () => {
    const full = move('full', { project: 'claude://default/other', from: 'inbox', to: 'in-review' })
    full.priority = 'high'
    full.epic = 'epic-the-wall-ii'
    recordCardMoves([full, move('bare')])

    restart()
    const back = readPersistedCardMoves(10)

    expect(back.find(m => m.id === 'full')).toEqual(full)
    // `priority`/`epic` come back ABSENT, not null -- a null on an optional
    // field is a value the pane would have to defend against.
    const bare = back.find(m => m.id === 'bare')
    expect(bare).toEqual(move('bare'))
    expect('priority' in (bare ?? {})).toBe(false)
    expect('epic' in (bare ?? {})).toBe(false)
  })

  test('reads newest first, the same order the ring serves', () => {
    for (let i = 0; i < 5; i++) recordCardMoves([move(`m${i}`, { ts: NOW - (5 - i) * SEC })])

    expect(readPersistedCardMoves(3).map(m => m.id)).toEqual(['m4', 'm3', 'm2'])
  })
})

describe('the rehydration seam', () => {
  test('rehydration does not re-file what it read -- one writer, one path', () => {
    recordCardMoves([move('once')])

    restart()
    rehydrateWallRings()
    rehydrateWallRings() // twice, to be sure the second is not a second row either

    expect(readPersistedCardMoves(100)).toHaveLength(1)
    expect(readCardLedger().map(m => m.id)).toEqual(['once', 'once']) // ring seeded twice, table not
  })

  test('rehydration takes at most a ring, oldest at the bottom', () => {
    const batch = Array.from({ length: CARD_LEDGER_CAP + 40 }, (_, i) => move(`m${i}`, { ts: NOW - (400 - i) * SEC }))
    persistCardMoves(batch)

    restart()
    rehydrateWallRings()

    const ids = readCardLedger().map(m => m.id)
    expect(ids).toHaveLength(CARD_LEDGER_CAP)
    expect(ids[0]).toBe(`m${CARD_LEDGER_CAP + 39}`) // newest on top
    expect(ids).not.toContain('m0') // the oldest fell off the front, not the newest
  })

  test('a cold store rehydrates to nothing rather than throwing', () => {
    restart()
    expect(() => rehydrateWallRings()).not.toThrow()
    expect(cardLedgerSize()).toBe(0)
  })
})

describe('replays', () => {
  test('the same move filed twice is one row', () => {
    recordCardMoves([move('dupe')])
    recordCardMoves([move('dupe')])

    expect(readPersistedCardMoves(10)).toHaveLength(1)
  })

  test('the same card moving again at a different instant is a second row', () => {
    recordCardMoves([move('card', { ts: NOW - SEC, from: 'open', to: 'in-progress' })])
    recordCardMoves([move('card', { ts: NOW, from: 'in-progress', to: 'done' })])

    expect(readPersistedCardMoves(10).map(m => m.to)).toEqual(['done', 'in-progress'])
  })

  test('two projects with the same card id do not collide', () => {
    recordCardMoves([move('same', { project: 'claude://a' }), move('same', { project: 'claude://b' })])

    expect(readPersistedCardMoves(10)).toHaveLength(2)
  })
})

describe('retention', () => {
  test('keeps everything inside the window', () => {
    persistCardMoves([move('recent', { ts: NOW - 30 * 24 * 60 * 60 * 1000 })])

    expect(sweepCardMoves(NOW)).toBe(0)
    expect(readPersistedCardMoves(10)).toHaveLength(1)
  })

  test('drops everything past it, and only that', () => {
    persistCardMoves([
      move('ancient', { ts: NOW - CARD_MOVE_RETENTION_MS - SEC }),
      move('edge', { ts: NOW - CARD_MOVE_RETENTION_MS }),
      move('fresh', { ts: NOW }),
    ])

    expect(sweepCardMoves(NOW)).toBe(1)
    expect(
      readPersistedCardMoves(10)
        .map(m => m.id)
        .sort(),
    ).toEqual(['edge', 'fresh'])
  })

  test('a second sweep over swept data changes nothing', () => {
    persistCardMoves([move('ancient', { ts: NOW - CARD_MOVE_RETENTION_MS - SEC })])
    sweepCardMoves(NOW)

    expect(sweepCardMoves(NOW)).toBe(0)
  })
})

describe('an uninitialized store', () => {
  test('swallows writes, reads and sweeps instead of throwing', () => {
    closeCardLedgerStore()

    expect(persistCardMoves([move('x')])).toBe(0)
    expect(readPersistedCardMoves(10)).toEqual([])
    expect(sweepCardMoves(NOW)).toBe(0)
  })

  test('the ring still works with no store behind it -- history is a bonus, not a dependency', () => {
    closeCardLedgerStore()

    recordCardMoves([move('live')])

    expect(readCardLedger().map(m => m.id)).toEqual(['live'])
  })

  test('a malformed move is refused at the door rather than written', () => {
    expect(persistCardMoves([move('bad', { ts: Number.NaN })])).toBe(0)
    expect(readPersistedCardMoves(10)).toEqual([])
  })
})
