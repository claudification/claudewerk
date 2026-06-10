import { describe, expect, test } from 'bun:test'
import { resolveContextWindow } from './context-window'
import { ALL_CC_SLUGS, isDefault1MFamily, resolveModelFamily, validateModel } from './models'
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

  test('validation accepts Fable + dynamic meta-aliases', () => {
    expect(validateModel('claude-fable-5').valid).toBe(true)
    expect(validateModel('fable').valid).toBe(true)
    expect(validateModel('best').valid).toBe(true)
    expect(validateModel('opusplan').valid).toBe(true)
    expect(validateModel('claude-bogus-9').valid).toBe(false)
    for (const slug of ['fable', 'fable[1m]', 'best', 'opusplan']) {
      expect(ALL_CC_SLUGS).toContain(slug)
    }
  })

  test('Fable lands in the Current dropdown group', () => {
    const current = MODEL_OPTION_GROUPS.find(g => g.group === 'Current')
    expect(current?.options.some(o => o.value === 'claude-fable-5')).toBe(true)
  })
})
