/**
 * Phase 1 (reset verbs) + Phase 2 (force-the-fold) behavior.
 *
 * The 30-hour bug: a short dispatcher chat left for a day stays UNDER the 1500-tok
 * hot-path size floor, so the per-turn policy never folds it -- you open and see the
 * raw last conversation. consolidateOnOpen is the fix: an AGE-gated, once-per-return
 * fold that bypasses the floor. compactNow / forgetUserMemory back the /compact and
 * /forget control verbs; resetUserHistory backs /clear.
 */

import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import { MEMORY_BLOCK_ID } from './consolidate'
import {
  compactNow,
  consolidateOnOpen,
  dumpUserHistory,
  forgetUserMemory,
  getUserHistory,
  resetUserHistory,
} from './history-store'
import { appendTurn, ONE_HOUR_MS, upsertBlock } from './living-history'

const stubChat =
  (content: string): ChatFn =>
  async req => ({
    content,
    raw: {},
    model: req.model,
    usage: {
      inputTokens: 50,
      outputTokens: 10,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      costUsd: 0.0001,
      costSource: 'openrouter',
    },
  })

const hasMemory = (user: string): boolean => dumpUserHistory(user).blocks.some(b => b.id === MEMORY_BLOCK_ID)
const memoryText = (user: string): string =>
  dumpUserHistory(user).blocks.find(b => b.id === MEMORY_BLOCK_ID)?.content ?? ''

describe('Phase 2 -- read-triggered fold (the 30-hour fix)', () => {
  test('folds a SMALL stale chat on open (bypasses the 1500-tok size floor)', async () => {
    const user = 'p2-open'
    resetUserHistory(user)
    const now = 40 * ONE_HOUR_MS
    const h = getUserHistory(user)
    // A tiny chat from 30h ago -- well under the size floor the hot path needs.
    appendTurn(h, 'user', 'tiny note from way back', now - 30 * ONE_HOUR_MS)
    appendTurn(h, 'assistant', 'ok', now - 30 * ONE_HOUR_MS)

    const res = await consolidateOnOpen(user, now, stubChat('- user left a tiny note'))

    expect(res?.ran).toBe(true) // the on-open fold runs where the hot-path policy would not
    const dump = dumpUserHistory(user)
    expect(dump.turns).toHaveLength(0) // aged turns dropped from the LLM window
    expect(memoryText(user)).toContain('tiny note') // condensed into <memory>
    resetUserHistory(user)
  })

  test('no-op (zero cost, no LLM call) when nothing has aged past the 1h horizon', async () => {
    const user = 'p2-fresh'
    resetUserHistory(user)
    const now = 2 * ONE_HOUR_MS
    appendTurn(getUserHistory(user), 'user', 'just now', now - 1000)
    let called = false
    const res = await consolidateOnOpen(user, now, async req => {
      called = true
      return stubChat('x')(req)
    })
    expect(res).toBeNull()
    expect(called).toBe(false)
    resetUserHistory(user)
  })
})

describe('Phase 1 -- control verbs', () => {
  test('/compact folds the WHOLE window now, regardless of age', async () => {
    const user = 'p1-compact'
    resetUserHistory(user)
    const now = 5 * ONE_HOUR_MS
    appendTurn(getUserHistory(user), 'user', 'fresh thing I said seconds ago', now - 2000)
    const res = await compactNow(user, now, stubChat('- folded everything'))
    expect(res.ran).toBe(true)
    expect(dumpUserHistory(user).turns).toHaveLength(0) // even the fresh turn folded
    expect(hasMemory(user)).toBe(true)
    resetUserHistory(user)
  })

  test('/forget drops <memory> but keeps the recent conversation', () => {
    const user = 'p1-forget'
    resetUserHistory(user)
    const now = 3 * ONE_HOUR_MS
    const h = getUserHistory(user)
    appendTurn(h, 'user', 'recent turn', now - 1000)
    upsertBlock(h, MEMORY_BLOCK_ID, 'memory', '- durable fact', now)
    expect(hasMemory(user)).toBe(true)

    forgetUserMemory(user)

    expect(hasMemory(user)).toBe(false) // long-term memory gone
    expect(dumpUserHistory(user).turns.map(t => t.content)).toEqual(['recent turn']) // chat kept
    resetUserHistory(user)
  })

  test('/clear wipes the whole living history', () => {
    const user = 'p1-clear'
    resetUserHistory(user)
    const h = getUserHistory(user)
    appendTurn(h, 'user', 'something', 1000)
    upsertBlock(h, MEMORY_BLOCK_ID, 'memory', '- a fact', 1000)
    resetUserHistory(user)
    const dump = dumpUserHistory(user)
    expect(dump.exists).toBe(false)
    expect(dump.turns).toHaveLength(0)
    expect(dump.blocks).toHaveLength(0)
  })
})
