import { describe, expect, test } from 'bun:test'
import { makePromptInputs, SIZES } from '../../__tests__/synthetic-fixtures'
import { buildPrompt, swapInstructions } from './prompt-builder'

describe('swapInstructions', () => {
  test('appends a directives block to a plain prompt', () => {
    const out = swapInstructions('BODY SPEC', 'keep it upbeat')
    expect(out.startsWith('BODY SPEC')).toBe(true)
    expect(out).toContain('keep it upbeat')
    expect(out).toContain('ADDITIONAL USER DIRECTIVES')
  })

  test('replaces an existing block instead of stacking (idempotent re-steer)', () => {
    const first = swapInstructions('BODY SPEC', 'be terse')
    const second = swapInstructions(first, 'be verbose')
    expect(second).toContain('be verbose')
    expect(second).not.toContain('be terse')
    // Exactly one directives block survives.
    expect(second.split('ADDITIONAL USER DIRECTIVES').length - 1).toBe(1)
  })

  test('a blank instruction strips the block back to the base prompt', () => {
    const withBlock = swapInstructions('BODY SPEC', 'be terse')
    expect(swapInstructions(withBlock, '')).toBe('BODY SPEC')
    expect(swapInstructions(withBlock, '   ')).toBe('BODY SPEC')
  })

  test('round-trips the block built by buildPrompt', () => {
    const built = buildPrompt(makePromptInputs('small'), 'human', false, false, undefined, 'original steer')
    const reSteered = swapInstructions(built.system, 'new steer')
    expect(reSteered).toContain('new steer')
    expect(reSteered).not.toContain('original steer')
    expect(reSteered.split('ADDITIONAL USER DIRECTIVES').length - 1).toBe(1)
  })
})

describe('buildPrompt', () => {
  test('emits non-empty system + user payloads', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.system.length).toBeGreaterThan(200)
    expect(out.user.length).toBeGreaterThan(50)
    expect(out.inputChars).toBe(out.system.length + out.user.length)
  })

  test('mentions the project label and period range in the system prompt', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.system).toContain(inputs.projectLabel)
    expect(out.system).toContain(inputs.periodHuman)
    expect(out.system).toContain(inputs.periodIsoRange)
  })

  test('user payload references a conversation id from the input', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.user).toContain('conv_000')
  })

  test('size grows monotonically with fixture size', () => {
    const small = buildPrompt(makePromptInputs('small'))
    const medium = buildPrompt(makePromptInputs('medium'))
    const large = buildPrompt(makePromptInputs('large'))
    expect(medium.inputChars).toBeGreaterThan(small.inputChars)
    expect(large.inputChars).toBeGreaterThan(medium.inputChars)
  })

  test('large fixture produces a substantial prompt (size-growth guard)', () => {
    const out = buildPrompt(makePromptInputs('large'))
    expect(out.inputChars).toBeGreaterThan(50_000)
  })

  test('retrospect appends the evaluative frontmatter + body spec (Pillar F)', () => {
    const inputs = makePromptInputs('small')
    const off = buildPrompt(inputs, 'human', false)
    const on = buildPrompt(inputs, 'human', true)
    expect(off.system).not.toContain('went_well')
    expect(off.system).not.toContain('## Retrospective')
    expect(on.system).toContain('went_well')
    expect(on.system).toContain('went_badly')
    expect(on.system).toContain('recommendations')
    expect(on.system).toContain('## Retrospective')
    expect(on.system.length).toBeGreaterThan(off.system.length)
  })

  test('retrospect threads through the agent audience too (additive, not a 3rd audience)', () => {
    const inputs = makePromptInputs('small')
    const on = buildPrompt(inputs, 'agent', true)
    expect(on.system).toContain('## Pick up here') // agent body still present
    expect(on.system).toContain('## Retrospective') // + retro appended
  })

  test('customerFriendly appends the sanitize-tone directive (off by default)', () => {
    const inputs = makePromptInputs('small')
    const off = buildPrompt(inputs, 'human', false, false)
    const on = buildPrompt(inputs, 'human', false, true)
    expect(off.system).not.toContain('CUSTOMER-FRIENDLY TONE')
    expect(on.system).toContain('CUSTOMER-FRIENDLY TONE')
    expect(on.system).toContain('OMIT the `frustrations`')
    expect(on.system.length).toBeGreaterThan(off.system.length)
  })

  test('customerFriendly is appended LAST so it overrides the retrospect + body spec', () => {
    const inputs = makePromptInputs('small')
    const on = buildPrompt(inputs, 'human', true, true)
    expect(on.system).toContain('## Retrospective')
    expect(on.system).toContain('CUSTOMER-FRIENDLY TONE')
    // tone directive must come AFTER the retrospect spec (override ordering)
    expect(on.system.indexOf('CUSTOMER-FRIENDLY TONE')).toBeGreaterThan(on.system.indexOf('## Retrospective'))
  })

  test('customerFriendly threads through the agent audience too', () => {
    const inputs = makePromptInputs('small')
    const on = buildPrompt(inputs, 'agent', false, true)
    expect(on.system).toContain('## Pick up here') // agent body still present
    expect(on.system).toContain('CUSTOMER-FRIENDLY TONE')
  })

  test('huge fixture is large but stays under the 1M-ctx ceiling (rides Opus)', () => {
    const out = buildPrompt(makePromptInputs('huge'))
    expect(out.inputChars).toBeGreaterThan(600_000)
    expect(out.inputChars).toBeLessThan(3_200_000)
  })

  test('OUTPUT FORMAT: includes both YAML frontmatter spec and TL;DR section', () => {
    const out = buildPrompt(makePromptInputs('small'))
    expect(out.system).toContain('YAML frontmatter')
    expect(out.system).toContain('TL;DR')
  })

  test('cost summary always appears in the user payload (deterministic from SQL)', () => {
    const out = buildPrompt(makePromptInputs('medium'))
    expect(out.user.toLowerCase()).toContain('cost')
  })

  test('open questions section surfaces when fixture has open questions', () => {
    const inputs = makePromptInputs('small')
    expect(inputs.openQuestions.conversationsWithOpenQuestions.length).toBeGreaterThan(0)
    const out = buildPrompt(inputs)
    // Section header in the user payload uses underscore form: OPEN_QUESTIONS
    expect(out.user).toContain('OPEN_QUESTIONS')
  })

  test('cost summary line exists with totals (per-day breakdown is intentionally NOT in prompt -- LLM must not regenerate numbers)', () => {
    const inputs = makePromptInputs('small')
    const out = buildPrompt(inputs)
    expect(out.user).toContain('COST SUMMARY')
    expect(out.user).toMatch(/total=\$\d/)
  })
})

describe('buildPrompt -- snapshot guards (size only, content not pinned)', () => {
  // Pin order-of-magnitude sizes so a refactor that 10x-inflates the prompt
  // is caught immediately. Tighter snapshot pinning would brittle-fail on
  // every prompt copy edit.
  for (const size of Object.keys(SIZES) as Array<keyof typeof SIZES>) {
    test(`size=${size}`, () => {
      const out = buildPrompt(makePromptInputs(size))
      expect(out.inputChars).toBeGreaterThan(0)
      expect(out.system.length).toBeLessThan(10_000)
    })
  }
})
