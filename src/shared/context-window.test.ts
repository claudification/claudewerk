import { describe, expect, test } from 'bun:test'
import { resolveContextModeFromText, resolveContextWindow, sanitizePersistedContextMode } from './context-window'

describe('resolveContextWindow -- explicit downgrade suffix', () => {
  test('[200k] beats a default-1M family', () => {
    expect(resolveContextWindow('claude-opus-4-8')).toBe(1_000_000)
    expect(resolveContextWindow('claude-opus-4-8[200k]')).toBe(200_000)
    expect(resolveContextWindow('claude-fable-5-200k')).toBe(200_000)
  })
})

describe('resolveContextModeFromText', () => {
  test('default-1M model named in the text is 1m even with no label', () => {
    expect(resolveContextModeFromText('opus (claude-opus-4-8)')).toBe('1m')
    expect(resolveContextModeFromText('Opus 4.8 for this session')).toBe('1m')
  })

  test('longest identifier wins over a bare alias substring', () => {
    // "sonnet" (alias -> Sonnet 5, default-1M) must not shadow the 4.6 id.
    expect(resolveContextModeFromText('sonnet (claude-sonnet-4-6)')).toBe('standard')
    // "Opus 4" (Opus 4.0) must not shadow "Opus 4.8".
    expect(resolveContextModeFromText('Opus 4.8')).toBe('1m')
    expect(resolveContextModeFromText('Opus 4')).toBe('standard')
  })

  test('explicit markers win over the registry', () => {
    expect(resolveContextModeFromText('claude-sonnet-4-6[1m]')).toBe('1m')
    expect(resolveContextModeFromText('Sonnet 4.6 (1M context)')).toBe('1m')
    expect(resolveContextModeFromText('claude-opus-4-8[200k]')).toBe('standard')
    expect(resolveContextModeFromText('Opus 4.8 (200K context)')).toBe('standard')
  })

  test('unknown text yields no verdict', () => {
    expect(resolveContextModeFromText('some-unreleased-model-9')).toBeUndefined()
    expect(resolveContextModeFromText('')).toBeUndefined()
  })
})

describe('sanitizePersistedContextMode', () => {
  test("drops a poisoned 'standard' on a default-1M model", () => {
    expect(sanitizePersistedContextMode('standard', 'claude-opus-4-8')).toBeUndefined()
    expect(sanitizePersistedContextMode('standard', 'claude-fable-5')).toBeUndefined()
  })

  test("keeps 'standard' where it is real", () => {
    expect(sanitizePersistedContextMode('standard', 'claude-sonnet-4-6')).toBe('standard')
    expect(sanitizePersistedContextMode('standard', 'claude-haiku-4-5')).toBe('standard')
    expect(sanitizePersistedContextMode('standard', 'claude-opus-4-8[200k]')).toBe('standard')
  })

  test('leaves 1m and undefined alone', () => {
    expect(sanitizePersistedContextMode('1m', 'claude-sonnet-4-6')).toBe('1m')
    expect(sanitizePersistedContextMode(undefined, 'claude-opus-4-8')).toBeUndefined()
    expect(sanitizePersistedContextMode('standard', undefined)).toBe('standard')
  })
})
