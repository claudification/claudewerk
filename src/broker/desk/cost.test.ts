import { describe, expect, it } from 'bun:test'
import { CACHE_TTL_COLD_MS, computeCostSignal, requiresConfirmation } from './cost'

describe('computeCostSignal', () => {
  it('cheap for small warm context', () => {
    const c = computeCostSignal({ contextTokens: 10_000, idleMs: 1000, model: 'haiku' })
    expect(c.tier).toBe('cheap')
    expect(c.coldCache).toBeUndefined()
  })

  it('very expensive past 150k context', () => {
    expect(computeCostSignal({ contextTokens: 180_000 }).tier).toBe('very_expensive')
  })

  it('opus is never below expensive even when small', () => {
    expect(computeCostSignal({ contextTokens: 5_000, model: 'claude-opus-4-8' }).tier).toBe('expensive')
  })

  it('cold cache + large context -> very expensive', () => {
    const c = computeCostSignal({ contextTokens: 100_000, idleMs: CACHE_TTL_COLD_MS + 1 })
    expect(c.tier).toBe('very_expensive')
    expect(c.coldCache).toBe(true)
  })

  it('warm 100k context is expensive but not very', () => {
    expect(computeCostSignal({ contextTokens: 100_000, idleMs: 1000 }).tier).toBe('expensive')
  })

  it('moderate band 40k-90k', () => {
    expect(computeCostSignal({ contextTokens: 50_000, idleMs: 0 }).tier).toBe('moderate')
  })

  it('note mentions the drivers', () => {
    const c = computeCostSignal({ contextTokens: 180_000, idleMs: CACHE_TTL_COLD_MS + 1, model: 'opus' })
    expect(c.note).toContain('Opus')
    expect(c.note).toContain('180k')
    expect(c.note).toContain('cold cache')
  })
})

describe('computeCostSignal -- active conversation override', () => {
  it('active 269k Opus = cheap (context is hot, no re-processing)', () => {
    const c = computeCostSignal({ contextTokens: 269_000, model: 'opus', isActive: true })
    expect(c.tier).toBe('cheap')
    expect(c.coldCache).toBeUndefined()
  })

  it('active 100k with cold idle time = still cheap (active overrides cold)', () => {
    const c = computeCostSignal({ contextTokens: 100_000, idleMs: CACHE_TTL_COLD_MS + 1, isActive: true })
    expect(c.tier).toBe('cheap')
    expect(c.coldCache).toBeUndefined()
  })

  it('active small context = cheap (no change from baseline)', () => {
    const c = computeCostSignal({ contextTokens: 5_000, model: 'haiku', isActive: true })
    expect(c.tier).toBe('cheap')
  })

  it('idle (not active) preserves original expensive behavior', () => {
    const c = computeCostSignal({ contextTokens: 200_000, model: 'opus', isActive: false })
    expect(c.tier).toBe('very_expensive')
  })

  it('isActive unset preserves original behavior (backwards compat)', () => {
    const c = computeCostSignal({ contextTokens: 200_000, model: 'opus' })
    expect(c.tier).toBe('very_expensive')
  })

  it('note reflects active state', () => {
    const c = computeCostSignal({ contextTokens: 269_000, model: 'opus', isActive: true })
    expect(c.note).toContain('active')
  })
})

describe('requiresConfirmation', () => {
  it('gates only very_expensive', () => {
    expect(requiresConfirmation({ tier: 'very_expensive' })).toBe(true)
    expect(requiresConfirmation({ tier: 'expensive' })).toBe(false)
    expect(requiresConfirmation(undefined)).toBe(false)
  })
})
