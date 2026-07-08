/**
 * splitCacheCreation is the single source of truth for the 5m/1h cache-write
 * split -- both the per-message time-series (token_samples) and the
 * per-conversation aggregate (conv.stats) call it, so they can't disagree.
 * The contract: KNOW the split from usage.cache_creation, don't guess it, and
 * always reconcile to the reported total exactly.
 */

import { describe, expect, it } from 'bun:test'
import { type MessageUsage, sampleFromMessageUsage, splitCacheCreation } from './token-usage'

describe('splitCacheCreation', () => {
  it('reads the real ephemeral 5m/1h split when present', () => {
    const usage: MessageUsage = {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 30 },
    }
    expect(splitCacheCreation(usage)).toEqual({ cacheWrite5mTokens: 70, cacheWrite1hTokens: 30 })
  })

  it('folds any rounding remainder into 5m so the split reconciles to the total', () => {
    const usage: MessageUsage = {
      input_tokens: 10,
      cache_creation_input_tokens: 100,
      cache_creation: { ephemeral_5m_input_tokens: 60, ephemeral_1h_input_tokens: 30 }, // 10 unaccounted
    }
    const { cacheWrite5mTokens, cacheWrite1hTokens } = splitCacheCreation(usage)
    expect(cacheWrite5mTokens).toBe(70) // 60 + 10 remainder
    expect(cacheWrite1hTokens).toBe(30)
    expect(cacheWrite5mTokens + cacheWrite1hTokens).toBe(100)
  })

  it('falls the whole total to 5m when the sub-object is absent (older transcripts)', () => {
    const usage: MessageUsage = { input_tokens: 10, cache_creation_input_tokens: 250 }
    expect(splitCacheCreation(usage)).toEqual({ cacheWrite5mTokens: 250, cacheWrite1hTokens: 0 })
  })

  it('is all-zero when there is no cache creation', () => {
    expect(splitCacheCreation({ input_tokens: 10 })).toEqual({ cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 })
  })
})

describe('sampleFromMessageUsage carries the split', () => {
  it('exposes cacheWrite5m/1h alongside the collapsed total', () => {
    const s = sampleFromMessageUsage(
      {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 900,
        cache_creation_input_tokens: 100,
        cache_creation: { ephemeral_5m_input_tokens: 70, ephemeral_1h_input_tokens: 30 },
      },
      'claude-opus-4',
      '',
    )
    expect(s).not.toBeNull()
    expect(s?.cacheWriteTokens).toBe(100)
    expect(s?.cacheWrite5mTokens).toBe(70)
    expect(s?.cacheWrite1hTokens).toBe(30)
  })

  it('returns null for synthetic blocks', () => {
    expect(sampleFromMessageUsage({ input_tokens: 10 }, '<synthetic>', '')).toBeNull()
  })
})
