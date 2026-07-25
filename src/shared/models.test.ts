import { describe, expect, test } from 'bun:test'
import { resolveContextWindow } from './context-window'
import { ALL_CC_SLUGS, canonicalizeModelSlug, isDefault1MFamily, resolveModelFamily, validateModel } from './models'
import { resolveSpawnConfig } from './spawn-defaults'
import { MODEL_OPTION_GROUPS } from './spawn-schema'

describe('Fable 5 / Mythos 5 registry', () => {
  test('families resolve with correct limits + tier', () => {
    const fable = resolveModelFamily('claude-fable-5')
    expect(fable?.displayName).toBe('Fable 5')
    expect(fable?.tier).toBe('current')
    expect(fable?.maxOutputTokens).toBe(128_000)
    expect(fable?.default1M).toBe(true)

    const mythos = resolveModelFamily('claude-mythos-5')
    expect(mythos?.displayName).toBe('Mythos 5')
    expect(mythos?.default1M).toBe(true)
  })

  test('bare + suffixed slugs all resolve to Fable', () => {
    for (const slug of ['fable', 'fable[1m]', 'claude-fable-5', 'claude-fable-5[1m]']) {
      expect(resolveModelFamily(slug)?.familyId).toBe('claude-fable-5')
    }
  })

  // Regression guard: the old opus-only regex in context-window.ts silently
  // sized Fable as 200K. Default-1M now flows from the registry.
  test('Fable/Mythos resolve to 1M context (regression guard)', () => {
    expect(resolveContextWindow('claude-fable-5')).toBe(1_000_000)
    expect(resolveContextWindow('fable')).toBe(1_000_000)
    expect(resolveContextWindow('claude-fable-5[1m]')).toBe(1_000_000)
    expect(resolveContextWindow('claude-mythos-5')).toBe(1_000_000)
    expect(resolveContextWindow('claude-mythos-preview')).toBe(1_000_000)
    // forward date-pinned slug still resolves via family prefix
    expect(isDefault1MFamily('claude-fable-5-20260610')).toBe(true)
  })

  test('non-1M models stay 200K, opus stays 1M', () => {
    expect(resolveContextWindow('claude-haiku-4-5')).toBe(200_000)
    expect(resolveContextWindow('claude-sonnet-4-6')).toBe(200_000)
    expect(resolveContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-5')).toBe(200_000)
  })

  test('validation accepts Fable + every bare/meta alias CC ships', () => {
    expect(validateModel('claude-fable-5').valid).toBe(true)
    expect(validateModel('claude-bogus-9').valid).toBe(false)
    // The full CC bare-alias set ($NH in the binary) all validate.
    for (const slug of ['fable', 'fable[1m]', 'opus[1m]', 'sonnet[1m]', 'best', 'opusplan']) {
      expect(validateModel(slug).valid).toBe(true)
      expect(ALL_CC_SLUGS).toContain(slug)
    }
  })

  test('the [1m] aliases resolve to their family + 1M window', () => {
    // Bare `opus` now resolves to Opus 5 -- CC 2.1.219 made it the default Opus.
    expect(resolveModelFamily('opus[1m]')?.familyId).toBe('claude-opus-5')
    expect(resolveModelFamily('sonnet[1m]')?.familyId).toBe('claude-sonnet-5')
    expect(resolveContextWindow('opus[1m]')).toBe(1_000_000)
    expect(resolveContextWindow('sonnet[1m]')).toBe(1_000_000)
  })

  test('Fable lands in the Current dropdown group as the `fable` alias', () => {
    const current = MODEL_OPTION_GROUPS.find(g => g.group === 'Current')
    expect(current?.options.some(o => o.value === 'fable')).toBe(true)
  })
})

describe('Opus 5 registry (CC 2.1.219 default Opus)', () => {
  test('family resolves with correct limits + tier + default-1M', () => {
    const opus5 = resolveModelFamily('claude-opus-5')
    expect(opus5?.displayName).toBe('Opus 5')
    expect(opus5?.tier).toBe('current')
    expect(opus5?.maxOutputTokens).toBe(128_000)
    expect(opus5?.default1M).toBe(true)
  })

  test('bare `opus`/`opus[1m]` resolve to Opus 5, not 4.8', () => {
    for (const slug of ['opus', 'opus[1m]', 'claude-opus-5', 'claude-opus-5[1m]']) {
      expect(resolveModelFamily(slug)?.familyId).toBe('claude-opus-5')
    }
    // 4.8 keeps only its qualified slugs
    expect(resolveModelFamily('claude-opus-4-8')?.familyId).toBe('claude-opus-4-8')
  })

  test('Opus 5 is 1M context by default (no [1m] suffix)', () => {
    expect(resolveContextWindow('opus')).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-5')).toBe(1_000_000)
    expect(isDefault1MFamily('claude-opus-5')).toBe(true)
    // forward date-pinned slug still resolves via family prefix
    expect(isDefault1MFamily('claude-opus-5-20260724')).toBe(true)
    // explicit downgrade still honored
    expect(resolveContextWindow('claude-opus-5[200k]')).toBe(200_000)
  })

  test('Opus 5 lands in the Current dropdown group as the `opus` alias', () => {
    const current = MODEL_OPTION_GROUPS.find(g => g.group === 'Current')
    expect(current?.options.some(o => o.value === 'opus')).toBe(true)
  })
})

describe('bare `mythos` shorthand (claudewerk-only alias)', () => {
  test('canonicalizeModelSlug expands mythos -> claude-mythos-5 (case-insensitive)', () => {
    expect(canonicalizeModelSlug('mythos')).toBe('claude-mythos-5')
    expect(canonicalizeModelSlug('MYTHOS')).toBe('claude-mythos-5')
  })

  test('canonicalizeModelSlug passes non-aliases + undefined through unchanged', () => {
    expect(canonicalizeModelSlug('claude-mythos-5')).toBe('claude-mythos-5')
    expect(canonicalizeModelSlug('fable')).toBe('fable') // real CC alias, not ours
    expect(canonicalizeModelSlug('claude-opus-4-8')).toBe('claude-opus-4-8')
    expect(canonicalizeModelSlug(undefined)).toBeUndefined()
  })

  test('mythos validates, resolves to the Mythos family, and is 1M', () => {
    expect(ALL_CC_SLUGS).toContain('mythos')
    expect(validateModel('mythos').valid).toBe(true)
    expect(resolveModelFamily('mythos')?.familyId).toBe('claude-mythos-5')
    expect(resolveContextWindow('mythos')).toBe(1_000_000)
  })

  test('resolveSpawnConfig expands a `mythos` model to claude-mythos-5', () => {
    expect(resolveSpawnConfig({ model: 'mythos' }).model).toBe('claude-mythos-5')
    // a real CC alias is left untouched (auto-tracks latest)
    expect(resolveSpawnConfig({ model: 'fable' }).model).toBe('fable')
  })

  test('Mythos 5 is offered in the Current dropdown group', () => {
    const current = MODEL_OPTION_GROUPS.find(g => g.group === 'Current')
    expect(current?.options.some(o => o.value === 'claude-mythos-5')).toBe(true)
  })
})

describe('registry pricing fallback', () => {
  test('Fable/Mythos price from CC_MODELS when LiteLLM is empty', async () => {
    // initModelPricing has not run in this test, so the LiteLLM map is empty --
    // getModelInfo must fall back to the registry launch price ($10/$50 per MTok).
    const { getModelInfo } = await import('../broker/model-pricing')
    const fable = getModelInfo('claude-fable-5')
    expect(fable?.inputCostPerToken).toBe(10 / 1_000_000)
    expect(fable?.outputCostPerToken).toBe(50 / 1_000_000)
    expect(getModelInfo('claude-mythos-5')?.outputCostPerToken).toBe(50 / 1_000_000)
    // Opus 5 is brand new -- LiteLLM won't have it yet, so the $5/$25 launch
    // fallback must fill the gap (bare `opus` alias resolves through the family).
    const opus5 = getModelInfo('claude-opus-5')
    expect(opus5?.inputCostPerToken).toBe(5 / 1_000_000)
    expect(opus5?.outputCostPerToken).toBe(25 / 1_000_000)
    expect(getModelInfo('opus')?.outputCostPerToken).toBe(25 / 1_000_000)
    // a model with no fallback price + not in LiteLLM => undefined (unchanged)
    expect(getModelInfo('claude-opus-4-8')).toBeUndefined()
  })
})
