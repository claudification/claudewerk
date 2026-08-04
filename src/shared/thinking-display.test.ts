import { describe, expect, it } from 'bun:test'
import {
  DEFAULT_THINKING_SUMMARIES,
  parseThinkingDisplay,
  THINKING_DISPLAY_ENV,
  THINKING_DISPLAY_FLAG,
  thinkingDisplayValue,
} from './thinking-display'

describe('thinkingDisplayValue', () => {
  it('defaults to summarized -- CC redacts thinking text unless asked', () => {
    expect(DEFAULT_THINKING_SUMMARIES).toBe(true)
    expect(thinkingDisplayValue(undefined)).toBe('summarized')
  })

  it('maps the boolean onto CC wire values', () => {
    expect(thinkingDisplayValue(true)).toBe('summarized')
    expect(thinkingDisplayValue(false)).toBe('omitted')
  })
})

describe('parseThinkingDisplay', () => {
  it('accepts only the two CC values', () => {
    expect(parseThinkingDisplay('summarized')).toBe('summarized')
    expect(parseThinkingDisplay('omitted')).toBe('omitted')
  })

  it('rejects junk, empty, and unset so callers fall back to the default', () => {
    expect(parseThinkingDisplay(undefined)).toBeUndefined()
    expect(parseThinkingDisplay('')).toBeUndefined()
    expect(parseThinkingDisplay('true')).toBeUndefined()
    expect(parseThinkingDisplay('SUMMARIZED')).toBeUndefined()
  })
})

describe('constants', () => {
  it('uses the CLAUDWERK_ env prefix (NAMING covenant) and the real CC flag', () => {
    expect(THINKING_DISPLAY_ENV).toBe('CLAUDWERK_THINKING_DISPLAY')
    expect(THINKING_DISPLAY_FLAG).toBe('--thinking-display')
  })
})
