/**
 * TEMPLATE WIRE (PLAN phase 3) -- a SELECTED template + its resolved option flags
 * reach the Liquid render context on BOTH paths. buildPrompt (oneshot) and
 * buildSynthesizePrompt (synthesize) previously always rendered the in-code DEFAULT
 * template; phase 3 threads `PresentationSelection` (template + optionFlags) through
 * to renderHumanBody. This pins that end-to-end: a custom template's body framing,
 * its `{{ scope_label }}` interpolation, and its `options.<id>` booleans all appear
 * in the rendered prompt, and a prompt-tweak option flips the rendered text.
 */
import { describe, expect, test } from 'bun:test'
import { makePromptInputs } from '../../__tests__/synthetic-fixtures'
import { type RecapTemplate, templateManifestSchema } from '../../templates'
import { makeEmptyMetadata } from '../chunk/merge'
import { buildSynthesizePrompt } from '../chunk/synthesize-prompt'
import { buildPrompt } from './prompt-builder'

// A synthetic template whose body branches on the render path AND reads a
// prompt-tweak option boolean -- so the rendered string proves the plumbing.
function makeTemplate(): RecapTemplate {
  return templateManifestSchema.parse({
    id: 'wire-probe',
    label: 'Wire probe',
    description: 'Synthetic template for the phase-3 wire test.',
    audience: 'human',
    options: [{ id: 'terse', label: 'Terse', default: false }],
    body: [
      '{%- if path == "synthesize" -%}SYNTH-FRAMING{%- else -%}ONESHOT-FRAMING{%- endif %}',
      'SCOPE={{ scope_label }}',
      '{% if options.terse %}TONE=TERSE{% else %}TONE=VERBOSE{% endif %}',
    ].join('\n'),
  })
}

const SYNTH_CTX = {
  projectLabel: 'remote-claude',
  periodHuman: 'this week',
  periodIsoRange: '2026-05-22..2026-05-29',
}

describe('template wire -> oneshot (buildPrompt)', () => {
  test('selected template renders its body, scope, and the resolved option boolean', () => {
    const template = makeTemplate()
    const inputs = makePromptInputs('small')
    const sys = buildPrompt(inputs, 'human', false, false, {
      template,
      optionFlags: { terse: true },
    }).system
    expect(sys).toContain('ONESHOT-FRAMING')
    // scope_label is the project label of the run (oneshot path interpolation).
    expect(sys).toContain(`SCOPE=${inputs.projectLabel}`)
    expect(sys).toContain('TONE=TERSE')
    expect(sys).not.toContain('TONE=VERBOSE')
  })

  test('the option boolean flips the rendered text', () => {
    const template = makeTemplate()
    const sys = buildPrompt(makePromptInputs('small'), 'human', false, false, {
      template,
      optionFlags: { terse: false },
    }).system
    expect(sys).toContain('TONE=VERBOSE')
    expect(sys).not.toContain('TONE=TERSE')
  })
})

describe('template wire -> synthesize (buildSynthesizePrompt)', () => {
  test('selected template renders the synthesize framing + the option boolean', () => {
    const template = makeTemplate()
    const sys = buildSynthesizePrompt(makeEmptyMetadata(), SYNTH_CTX, 'human', false, false, {
      template,
      optionFlags: { terse: true },
    }).system
    expect(sys).toContain('SYNTH-FRAMING')
    expect(sys).toContain('SCOPE=remote-claude')
    expect(sys).toContain('TONE=TERSE')
  })
})
