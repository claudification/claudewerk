import { describe, expect, it, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { chunkModels, mapModelForSuite, oneshotModelForSuite, pickModel, reduceModelForSuite } from './escalate'
import { buildPrompt } from './prompt-builder'

// Ceiling is 3.2M chars (Opus 4.8 1M-token window headroom). Below it, human
// recaps ride Opus; only genuinely-huge inputs fall back to Sonnet.
const OVER_CEILING = 3_300_000

describe('pickModel', () => {
  test('the SUITE picks the oneshot model, at any normal size', () => {
    expect(pickModel(1000).reason).toBe('suite')
    expect(pickModel(1000).model).toContain('opus') // default suite = accurate
    expect(pickModel(2_000_000).reason).toBe('suite') // big but under ceiling
  })

  // BEHAVIOUR CHANGE (2026-07-27): audience used to pick the model (human ->
  // Opus, agent -> Sonnet). It no longer does -- the suite does, and audience
  // decides only what the document says. A cheap agent brief is now spelled
  // `suite: 'cheap'`, which states the same request honestly instead of hiding
  // a cost decision inside a content decision.
  test('audience no longer changes the model -- the suite does', () => {
    expect(pickModel(1000, 'agent').model).toBe(pickModel(1000, 'human').model)
    expect(pickModel(1000, 'agent', 'cheap').model).toContain('glm')
    expect(pickModel(1000, 'human', 'cheap').model).toContain('glm')
  })

  test('inputs over the 1M-ctx ceiling fall back to Sonnet (best-effort safety valve)', () => {
    const m = pickModel(OVER_CEILING)
    expect(m.model).toContain('sonnet')
    expect(m.reason).toBe('too-big')
  })

  test('the capacity ceiling beats the suite (too-big wins)', () => {
    expect(pickModel(OVER_CEILING, 'agent').reason).toBe('too-big')
    expect(pickModel(OVER_CEILING, 'human', 'cheap').reason).toBe('too-big')
  })
})

describe('pickModel integrated with fixture sizes', () => {
  test('all synthetic fixtures stay under the ceiling -> the suite model', () => {
    for (const size of ['small', 'medium', 'large', 'huge'] as const) {
      const out = buildPrompt(makePromptInputs(size))
      expect(out.inputChars).toBeLessThan(OVER_CEILING)
      expect(pickModel(out.inputChars).reason).toBe('suite')
    }
  })
})

describe('chunkModels (Pillar A/D map+reduce resolution)', () => {
  test('defaults map to Sonnet, reduce to Opus', () => {
    expect(chunkModels()).toEqual({
      mapModel: 'anthropic/claude-sonnet-5',
      reduceModel: 'anthropic/claude-opus-4.8',
    })
  })

  test('honours per-call overrides (Pillar D tuning)', () => {
    expect(chunkModels({ mapModel: 'x/cheap', reduceModel: 'y/strong' })).toEqual({
      mapModel: 'x/cheap',
      reduceModel: 'y/strong',
    })
  })

  test('falls back to default when an override is empty/undefined', () => {
    expect(chunkModels({ mapModel: '' })).toEqual({
      mapModel: 'anthropic/claude-sonnet-5',
      reduceModel: 'anthropic/claude-opus-4.8',
    })
  })
})

// TIERED SYNTHESIS (Jonas, 2026-07-27): "GLM-5.2 for automated and OPUS 4.8 for
// customer facing USER REQUESTED". The two kinds of recap have different stakes
// -- one is machinery feeding a searchable layer, the other gets read by a
// person who will judge it -- so they get different synthesis models.
describe('per-stage model resolution from a suite', () => {
  it('maps each stage to the suite that owns it', () => {
    expect(reduceModelForSuite('accurate')).toBe('anthropic/claude-opus-4.8')
    expect(reduceModelForSuite('cheap')).toBe('z-ai/glm-5.2')
    expect(oneshotModelForSuite('accurate')).toBe('anthropic/claude-opus-4.8')
    expect(oneshotModelForSuite('cheap')).toBe('z-ai/glm-5.2')
  })

  it('keeps the MAP model identical across suites', () => {
    // Extraction is cached for 60 days, so a cheap map model's thinner output
    // poisons every recap touching that conversation for two months. `cheap`
    // buys its savings from synthesis only, where output is regenerable.
    expect(mapModelForSuite('cheap')).toBe(mapModelForSuite('accurate'))
  })

  it('falls back to the default suite for an unknown or missing id', () => {
    expect(reduceModelForSuite(undefined)).toBe('anthropic/claude-opus-4.8')
    expect(reduceModelForSuite('nonsense')).toBe('anthropic/claude-opus-4.8')
  })

  it('is NOT Opus 5 -- it truncates at the 32k cap and costs 42% more', () => {
    expect(reduceModelForSuite('accurate')).not.toContain('opus-5')
  })
})

describe('chunkModels', () => {
  it('resolves both stages from the suite', () => {
    expect(chunkModels({}, 'cheap').reduceModel).toBe('z-ai/glm-5.2')
    expect(chunkModels({}, 'accurate').reduceModel).toBe('anthropic/claude-opus-4.8')
  })

  it('defaults to the accurate suite when none is given', () => {
    expect(chunkModels().reduceModel).toBe('anthropic/claude-opus-4.8')
  })

  it('lets an explicit per-stage slug beat the suite (eval harness)', () => {
    expect(chunkModels({ reduceModel: 'x/custom' }, 'cheap').reduceModel).toBe('x/custom')
    expect(chunkModels({ mapModel: 'x/map' }, 'accurate').mapModel).toBe('x/map')
  })
})
