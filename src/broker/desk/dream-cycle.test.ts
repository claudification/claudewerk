/**
 * Dream-cycle (Phase 3): the rare Opus re-ground of <memory>. It tidies what the
 * cheap live fold accrued -- dedup, supersede, tighten -- without folding new turns.
 */

import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import { MEMORY_BLOCK_ID } from './consolidate'
import { DREAM_MIN_MEMORY_CHARS, dreamCycle } from './dream-cycle'
import { createHistory, getBlock, upsertBlock } from './living-history'

const stubChat =
  (content: string, spy?: { model?: string }): ChatFn =>
  async req => {
    if (spy) spy.model = req.model
    return {
      content,
      raw: {},
      model: req.model,
      usage: {
        inputTokens: 200,
        outputTokens: 80,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.01,
        costSource: 'openrouter',
      },
    }
  }

const throwingChat: ChatFn = async () => {
  throw new Error('provider down')
}

const longMemory = `- ${'fact about the user that is long enough to be worth re-grounding. '.repeat(6)}`

describe('dreamCycle', () => {
  test('no-op (no LLM call) when memory is below the floor', async () => {
    const h = createHistory()
    upsertBlock(h, MEMORY_BLOCK_ID, 'memory', '- tiny', 1000)
    expect('- tiny'.length).toBeLessThan(DREAM_MIN_MEMORY_CHARS)
    let called = false
    const res = await dreamCycle(h, 2000, async req => {
      called = true
      return stubChat('x')(req)
    })
    expect(called).toBe(false)
    expect(res.ran).toBe(false)
    expect(getBlock(h, MEMORY_BLOCK_ID)?.content).toBe('- tiny') // untouched
  })

  test('re-grounds the memory block in place with the Opus tier', async () => {
    const h = createHistory()
    upsertBlock(h, MEMORY_BLOCK_ID, 'memory', longMemory, 1000)
    const spy: { model?: string } = {}
    const res = await dreamCycle(h, 2000, stubChat('- one tight deduped fact', spy))
    expect(res.ran).toBe(true)
    expect(spy.model).toContain('opus') // dream tier, not the Haiku live fold
    expect(getBlock(h, MEMORY_BLOCK_ID)?.content).toBe('- one tight deduped fact')
    expect(res.afterChars).toBeLessThan(res.beforeChars)
  })

  test('keeps the existing memory on LLM failure (no loss)', async () => {
    const h = createHistory()
    upsertBlock(h, MEMORY_BLOCK_ID, 'memory', longMemory, 1000)
    const res = await dreamCycle(h, 2000, throwingChat)
    expect(res.ran).toBe(false)
    expect(getBlock(h, MEMORY_BLOCK_ID)?.content).toBe(longMemory) // unchanged
  })
})
