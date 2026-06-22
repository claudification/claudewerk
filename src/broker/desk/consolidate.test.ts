import { describe, expect, test } from 'bun:test'
import type { ChatFn } from './classify'
import { CONSOLIDATE_MODEL, consolidate, MAX_MEMORY_CHARS, MEMORY_BLOCK_ID } from './consolidate'
import { appendTurn, createHistory, getBlock, ONE_HOUR_MS, toMessages } from './living-history'

/** A stub ChatFn that returns fixed content + records the prompt it saw. */
function stubChat(content: string, spy?: { user?: string; model?: string }): ChatFn {
  return async req => {
    if (spy) {
      spy.user = req.user
      spy.model = req.model
    }
    return {
      content,
      raw: {},
      model: req.model,
      usage: {
        inputTokens: 100,
        outputTokens: 20,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        costUsd: 0.0001,
        costSource: 'openrouter',
      },
    }
  }
}

const throwingChat: ChatFn = async () => {
  throw new Error('provider down')
}

describe('consolidate fold', () => {
  test('SHORT-CIRCUIT: nothing aged out -> no LLM call, no-op', async () => {
    const h = createHistory()
    appendTurn(h, 'user', 'fresh', 1000)
    let called = false
    const chat: ChatFn = async req => {
      called = true
      return stubChat('x')(req)
    }
    const res = await consolidate({ history: h, now: 2000 }, chat)
    expect(called).toBe(false)
    expect(res.ran).toBe(false)
    expect(res.foldedTurns).toBe(0)
    expect(h.turns).toHaveLength(1) // turn kept
  })

  test('folds aged turns into the <memory> block + drops them from raw history', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'remember I prefer Sonnet for moderate tasks', now - ONE_HOUR_MS - 1)
    appendTurn(h, 'assistant', 'noted', now - ONE_HOUR_MS - 1)
    appendTurn(h, 'user', 'still here', now - 1000) // fresh, must survive
    const spy: { user?: string } = {}
    const res = await consolidate({ history: h, now }, stubChat('- prefers Sonnet for moderate tasks', spy))
    expect(res.ran).toBe(true)
    expect(res.foldedTurns).toBe(2)
    // aged turns dropped, fresh one kept
    expect(h.turns.map(t => t.content)).toEqual(['still here'])
    // memory block written
    expect(getBlock(h, MEMORY_BLOCK_ID)?.content).toBe('- prefers Sonnet for moderate tasks')
    // the fold saw the aged turns, not the fresh one
    expect(spy.user).toContain('prefer Sonnet')
    expect(spy.user).not.toContain('still here')
  })

  test('LLM failure -> no-op: memory AND aged turns preserved (no silent loss)', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old', now - ONE_HOUR_MS - 1)
    const res = await consolidate({ history: h, now }, throwingChat)
    expect(res.ran).toBe(false)
    expect(res.foldedTurns).toBe(0)
    expect(h.turns).toHaveLength(1) // turn NOT lost
    expect(getBlock(h, MEMORY_BLOCK_ID)).toBeUndefined()
  })

  test('existing memory is fed to the fold so it can supersede in place', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    h.blocks.set(MEMORY_BLOCK_ID, { kind: 'block', id: MEMORY_BLOCK_ID, tag: 'memory', content: 'old memory', ts: 1 })
    appendTurn(h, 'user', 'new fact', now - ONE_HOUR_MS - 1)
    const spy: { user?: string } = {}
    await consolidate({ history: h, now }, stubChat('merged memory', spy))
    expect(spy.user).toContain('old memory')
    expect(getBlock(h, MEMORY_BLOCK_ID)?.content).toBe('merged memory')
  })

  test('memory output is capped to MAX_MEMORY_CHARS', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old', now - ONE_HOUR_MS - 1)
    const huge = 'x'.repeat(MAX_MEMORY_CHARS + 500)
    await consolidate({ history: h, now }, stubChat(huge))
    const mem = getBlock(h, MEMORY_BLOCK_ID)?.content ?? ''
    expect(mem.length).toBeLessThanOrEqual(MAX_MEMORY_CHARS + 1) // +1 for the … ellipsis
  })

  test('model override is honoured; default is CONSOLIDATE_MODEL', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    appendTurn(h, 'user', 'old', now - ONE_HOUR_MS - 1)
    const spy: { model?: string } = {}
    await consolidate({ history: h, now, model: 'anthropic/claude-opus-4' }, stubChat('m', spy))
    expect(spy.model).toBe('anthropic/claude-opus-4')
    // default model when none passed
    const h2 = createHistory()
    appendTurn(h2, 'user', 'old', now - ONE_HOUR_MS - 1)
    const spy2: { model?: string } = {}
    await consolidate({ history: h2, now }, stubChat('m', spy2))
    expect(spy2.model).toBe(CONSOLIDATE_MODEL)
  })

  test('after a fold the rendered context is smaller', async () => {
    const h = createHistory()
    const now = 10 * ONE_HOUR_MS
    for (let i = 0; i < 8; i++) appendTurn(h, 'user', 'a verbose aged turn '.repeat(10), now - ONE_HOUR_MS - 1)
    const before = JSON.stringify(toMessages(h)).length
    await consolidate({ history: h, now }, stubChat('- one tiny memory line'))
    const after = JSON.stringify(toMessages(h)).length
    expect(after).toBeLessThan(before)
  })
})
