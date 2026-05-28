import { describe, expect, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { pickModel } from './escalate'
import { buildPrompt } from './prompt-builder'

// Ceiling is 3.2M chars (Opus 4.8 1M-token window headroom). Below it, human
// recaps ride Opus; only genuinely-huge inputs fall back to Sonnet.
const OVER_CEILING = 3_300_000

describe('pickModel', () => {
  test('human recaps default to Opus across normal sizes (eat the cost, 1M ctx)', () => {
    expect(pickModel(1000).reason).toBe('human-floor')
    expect(pickModel(1000).model).toContain('opus')
    expect(pickModel(2_000_000).reason).toBe('human-floor') // big but under ceiling -> still Opus
  })

  test('agent briefs use Sonnet', () => {
    const m = pickModel(1000, 'agent')
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('agent-floor')
  })

  test('inputs over the 1M-ctx ceiling fall back to Sonnet (best-effort safety valve)', () => {
    const m = pickModel(OVER_CEILING)
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('too-big')
  })

  test('agent over the ceiling is also Sonnet (too-big wins)', () => {
    expect(pickModel(OVER_CEILING, 'agent').reason).toBe('too-big')
  })
})

describe('pickModel integrated with fixture sizes', () => {
  test('all synthetic fixtures stay under the ceiling -> Opus (human-floor)', () => {
    for (const size of ['small', 'medium', 'large', 'huge'] as const) {
      const out = buildPrompt(makePromptInputs(size))
      expect(out.inputChars).toBeLessThan(OVER_CEILING)
      expect(pickModel(out.inputChars).reason).toBe('human-floor')
    }
  })
})
