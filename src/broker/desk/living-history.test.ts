import { describe, expect, test } from 'bun:test'
import {
  agedTurns,
  appendTurn,
  createHistory,
  DEFAULT_MIN_SIZE_FOR_TIME_TRIGGER,
  DEFAULT_SIZE_TOKEN_LIMIT,
  dropBlock,
  estimateTokens,
  getBlock,
  ONE_HOUR_MS,
  shouldConsolidate,
  TEN_MIN_MS,
  toMessages,
  upsertBlock,
} from './living-history'

describe('mutations', () => {
  test('append turns + render to a message array (state block leads, dialogue follows)', () => {
    const h = createHistory()
    upsertBlock(h, 'fleet', 'fleet', 'arr: idle', 1)
    appendTurn(h, 'user', 'check with arr', 2)
    appendTurn(h, 'assistant', 'on it', 3)
    const msgs = toMessages(h)
    expect(msgs[0]).toEqual({ role: 'user', content: '<fleet id="fleet">\narr: idle\n</fleet>' })
    expect(msgs[1]).toEqual({ role: 'user', content: 'check with arr' })
    expect(msgs[2]).toEqual({ role: 'assistant', content: 'on it' })
  })

  test('upsert REWRITES a block in place by id (pending -> findings, same slot)', () => {
    const h = createHistory()
    upsertBlock(h, 'fleet', 'fleet', 'x', 1)
    upsertBlock(h, 'q1', 'pending', 'asked arr', 2)
    upsertBlock(h, 'q1', 'findings', 'Dune Part Three', 3) // the mutation
    expect(h.blocks.size).toBe(2) // not 3 -- same id reused
    expect(getBlock(h, 'q1')?.tag).toBe('findings')
    expect(getBlock(h, 'q1')?.content).toBe('Dune Part Three')
    // order preserved: fleet still first, q1 second
    expect([...h.blocks.keys()]).toEqual(['fleet', 'q1'])
  })

  test('dropBlock removes a resolved block (context shrinks)', () => {
    const h = createHistory()
    upsertBlock(h, 'q1', 'findings', 'x', 1)
    dropBlock(h, 'q1')
    expect(getBlock(h, 'q1')).toBeUndefined()
    expect(toMessages(h)).toHaveLength(0)
  })

  test('no blocks -> no leading state message', () => {
    const h = createHistory()
    appendTurn(h, 'user', 'hi', 1)
    expect(toMessages(h)).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('consolidation policy', () => {
  test('agedTurns picks only turns past the 1h horizon', () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old', now - ONE_HOUR_MS - 1)
    appendTurn(h, 'user', 'fresh', now - 1000)
    expect(agedTurns(h, now).map(t => t.content)).toEqual(['old'])
  })

  test('SHORT-CIRCUITS when nothing aged out and under size (no LLM cost)', () => {
    const h = createHistory()
    appendTurn(h, 'user', 'fresh', 1000)
    expect(shouldConsolidate({ history: h, now: 2000, lastRunAt: 0 })).toBe(false)
  })

  test('TIME: aged turns fold only once the 10-min interval elapsed', () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old', now - ONE_HOUR_MS - 1)
    // floor 0 isolates the pure time mechanic (this history is tiny).
    // interval NOT elapsed -> wait
    expect(shouldConsolidate({ history: h, now, lastRunAt: now - TEN_MIN_MS + 1, minSizeForTimeTrigger: 0 })).toBe(
      false,
    )
    // interval elapsed -> go
    expect(shouldConsolidate({ history: h, now, lastRunAt: now - TEN_MIN_MS, minSizeForTimeTrigger: 0 })).toBe(true)
  })

  test('SIZE FLOOR: a tiny aged history does NOT fold on the time path (§8a)', () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old but small', now - ONE_HOUR_MS - 1)
    // aged + interval elapsed, but under the 1500-tok floor -> no fold (would be a
    // net cost loss at Haiku prices). Default floor applies.
    expect(shouldConsolidate({ history: h, now, lastRunAt: now - ONE_HOUR_MS })).toBe(false)
    // cross the floor with bulk -> the time path fires.
    upsertBlock(h, 'bulk', 'memory', 'x'.repeat((DEFAULT_MIN_SIZE_FOR_TIME_TRIGGER + 100) * 4), now - ONE_HOUR_MS)
    expect(shouldConsolidate({ history: h, now, lastRunAt: now - ONE_HOUR_MS })).toBe(true)
  })

  test('SIZE VALVE: over the token limit condenses immediately, bypassing the interval', () => {
    const h = createHistory()
    upsertBlock(h, 'big', 'memory', 'x'.repeat(DEFAULT_SIZE_TOKEN_LIMIT * 4 + 100), 1000)
    // no aged turns, interval not elapsed -- but it's too big
    expect(shouldConsolidate({ history: h, now: 2000, lastRunAt: 1999 })).toBe(true)
  })

  test('estimateTokens grows with content', () => {
    const h = createHistory()
    expect(estimateTokens(h)).toBe(0)
    appendTurn(h, 'user', 'x'.repeat(400), 1)
    expect(estimateTokens(h)).toBe(100)
  })
})
