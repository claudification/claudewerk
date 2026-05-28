import { describe, expect, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { pickModel } from './escalate'
import { buildPrompt } from './prompt-builder'

describe('pickModel', () => {
  test('human recaps default to Opus regardless of (sub-ceiling) size', () => {
    expect(pickModel(1000).reason).toBe('human-floor')
    expect(pickModel(1000).model).toContain('opus')
    expect(pickModel(200_000).reason).toBe('human-floor')
  })

  test('agent briefs use Sonnet', () => {
    const m = pickModel(1000, 'agent')
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('agent-floor')
  })

  test('inputs over the chunk ceiling fall back to Sonnet (cost guard)', () => {
    const m = pickModel(600_001)
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('too-big')
  })

  test('agent over the ceiling is also Sonnet (too-big wins)', () => {
    expect(pickModel(600_001, 'agent').reason).toBe('too-big')
  })
})

describe('pickModel integrated with fixture sizes', () => {
  test('small/medium/large human fixtures -> Opus (human-floor)', () => {
    for (const size of ['small', 'medium', 'large'] as const) {
      const out = buildPrompt(makePromptInputs(size))
      expect(pickModel(out.inputChars).reason).toBe('human-floor')
    }
  })

  test('huge fixture -> Sonnet cost guard (too-big)', () => {
    const out = buildPrompt(makePromptInputs('huge'))
    expect(pickModel(out.inputChars).reason).toBe('too-big')
  })
})
