import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEpicLog, dispatchCountsByCard, readEpicLog, readEpicLogSlice } from './epic-log'

let root: string
const T0 = Date.parse('2026-08-18T10:00:00.000Z')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'epic-slice-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Twelve entries: alternating dispatch/verdict, cards t1..t6. */
function seed() {
  for (let i = 0; i < 12; i++) {
    appendEpicLog(
      root,
      'e1',
      {
        kind: i % 2 === 0 ? 'dispatch' : 'verdict',
        convId: `conv_${i}`,
        cardId: `t${Math.floor(i / 2) + 1}`,
        body: `entry ${i}`,
      },
      T0 + i * 1000,
    )
  }
}

describe('readEpicLogSlice', () => {
  test('a missing log is empty, not a throw', () => {
    expect(readEpicLogSlice(root, 'never-run')).toEqual([])
  })

  test('the default is the prompt-sized tail a werk-master generation is handed', () => {
    seed()
    expect(readEpicLogSlice(root, 'e1')).toHaveLength(12)
  })

  test('a limit takes the NEWEST entries', () => {
    seed()
    const out = readEpicLogSlice(root, 'e1', { limit: 3 })
    expect(out.map(e => e.body)).toEqual(['entry 9', 'entry 10', 'entry 11'])
  })

  test('a kind filter searches the WHOLE log, not just the default tail', () => {
    seed()
    const verdicts = readEpicLogSlice(root, 'e1', { kinds: ['verdict'] })
    expect(verdicts).toHaveLength(6)
    expect(verdicts.every(e => e.kind === 'verdict')).toBe(true)
  })

  test('filter THEN tail -- "the last 2 verdicts" means 2 verdicts, not however many fall in the last 2 entries', () => {
    seed()
    const out = readEpicLogSlice(root, 'e1', { kinds: ['verdict'], limit: 2 })
    expect(out.map(e => e.body)).toEqual(['entry 9', 'entry 11'])
  })

  test('a card filter answers "everything that ever happened to t2"', () => {
    seed()
    const out = readEpicLogSlice(root, 'e1', { cardId: 't2' })
    expect(out.map(e => e.body)).toEqual(['entry 2', 'entry 3'])
  })

  test('kind and card compose', () => {
    seed()
    expect(readEpicLogSlice(root, 'e1', { cardId: 't2', kinds: ['verdict'] }).map(e => e.body)).toEqual(['entry 3'])
  })

  test('an empty kinds list means no filter, not "match nothing"', () => {
    seed()
    expect(readEpicLogSlice(root, 'e1', { kinds: [] })).toHaveLength(12)
  })

  test('a nonsense limit falls back to the default rather than returning nothing', () => {
    seed()
    expect(readEpicLogSlice(root, 'e1', { limit: 0 })).toHaveLength(12)
    expect(readEpicLogSlice(root, 'e1', { limit: -5 })).toHaveLength(12)
  })

  test('a limit past the end returns everything, not a padded list', () => {
    seed()
    expect(readEpicLogSlice(root, 'e1', { limit: 999 })).toHaveLength(12)
  })
})

/**
 * THE CEILING'S DENOMINATOR (`MAX_CARD_SEATS`). Counted from the BATON rather
 * than from the conversation registry because a `dispatch` entry is written the
 * instant a spawn is accepted, whereas the conversation behind it carries no
 * epic tag until its agent host connects -- so a registry count reads zero in
 * exactly the window a runaway starts in.
 */
describe('dispatchCountsByCard', () => {
  test('an empty log counts nothing', () => {
    expect(dispatchCountsByCard([])).toEqual({})
  })

  test('counts one seat per dispatch entry, per card', () => {
    seed()
    // The seed alternates dispatch/verdict over t1..t6, so every card has
    // exactly one dispatch entry and one verdict.
    expect(dispatchCountsByCard(readEpicLog(root, 'e1'))).toEqual({ t1: 1, t2: 1, t3: 1, t4: 1, t5: 1, t6: 1 })
  })

  test('a redispatched card accumulates -- the count is the ceiling, so it must not reset', () => {
    for (const i of [0, 1, 2]) {
      appendEpicLog(root, 'e1', { kind: 'dispatch', convId: `c${i}`, cardId: 't1', body: '' }, T0 + i)
    }
    expect(dispatchCountsByCard(readEpicLog(root, 'e1')).t1).toBe(3)
  })

  /** A failed launch already has its own `dispatch` entry ahead of it, and the
   *  launch path has its own bound in `MAX_LAUNCH_ATTEMPTS`. */
  test('a dispatch-failed entry is not a second seat', () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c1', cardId: 't1', body: '' }, T0)
    appendEpicLog(root, 'e1', { kind: 'dispatch-failed', convId: 'c1', cardId: 't1', body: '' }, T0 + 1)
    expect(dispatchCountsByCard(readEpicLog(root, 'e1')).t1).toBe(1)
  })

  test('an entry with no card belongs to no card', () => {
    appendEpicLog(root, 'e1', { kind: 'dispatch', convId: 'c1', body: 'no card' }, T0)
    expect(dispatchCountsByCard(readEpicLog(root, 'e1'))).toEqual({})
  })
})
