import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { appendEpicLog, readEpicLogSlice } from './epic-log'

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

  test('the default is the prompt-sized tail an overseer generation is handed', () => {
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
