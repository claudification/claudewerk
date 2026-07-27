import { describe, expect, it, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { chunkModels, pickModel, reduceModelForTier, resolveTier } from './escalate'
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
describe('resolveTier (who is waiting, not who it is addressed to)', () => {
  it('sends an unattended scheduled run to economy', () => {
    expect(resolveTier({ unattended: true })).toBe('economy')
  })

  it('sends anything a user asked for to premium', () => {
    expect(resolveTier({ unattended: false })).toBe('premium')
  })

  it('forces premium for customer-facing output even when scheduled', () => {
    // A scheduled customer-facing recap still lands in front of someone who did
    // not sign up to read machine output. Customer-facing wins outright.
    expect(resolveTier({ unattended: true, customerFriendly: true })).toBe('premium')
    expect(resolveTier({ unattended: false, customerFriendly: true })).toBe('premium')
  })
})

describe('reduceModelForTier', () => {
  it('maps the tiers to the measured winners', () => {
    expect(reduceModelForTier('premium')).toBe('anthropic/claude-opus-4.8')
    expect(reduceModelForTier('economy')).toBe('z-ai/glm-5.2')
  })

  it('is NOT Opus 5 -- it truncates at the 32k cap and costs 42% more', () => {
    // Guards the revert: Opus 5 looked free on the price card and was not.
    expect(reduceModelForTier('premium')).not.toContain('opus-5')
  })
})

describe('chunkModels tiering', () => {
  it('defaults to premium when no tier is given', () => {
    expect(chunkModels().reduceModel).toBe('anthropic/claude-opus-4.8')
  })

  it('resolves the reduce model from the tier', () => {
    expect(chunkModels({}, 'economy').reduceModel).toBe('z-ai/glm-5.2')
    expect(chunkModels({}, 'premium').reduceModel).toBe('anthropic/claude-opus-4.8')
  })

  it('lets an explicit override beat the tier (Pillar D / eval harness)', () => {
    expect(chunkModels({ reduceModel: 'x/custom' }, 'economy').reduceModel).toBe('x/custom')
  })

  it('never tiers the MAP model -- extraction quality is cached for 60 days', () => {
    expect(chunkModels({}, 'economy').mapModel).toBe(chunkModels({}, 'premium').mapModel)
  })
})
