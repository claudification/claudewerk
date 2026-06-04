/**
 * resolveRecipe -- the PLAN-phase-3 fold: the requested template + user option
 * overrides resolve into the presentation recipe (template id + option flags +
 * signal set + audience) that drives the prompt, the cache key, and args_json.
 *
 * Exercised against the REAL committed templates dir (the dev fallback resolves
 * to repo `recap-templates/`, which holds the `project-recap` anchor). The pure
 * option engine (resolveOptionFlags / resolveTemplateSignals) is unit-tested in
 * templates.test.ts; here we pin the orchestrator-level COMPOSITION + the
 * untemplated-default invariants the wiring must preserve.
 */
import { describe, expect, test } from 'bun:test'
import type { RecapSignal } from '../../../shared/protocol'
import { DEFAULT_TEMPLATE_ID } from '../templates'
import { resolveRecipe, type StartArgs } from './orchestrator'

function makeArgs(extra: Partial<StartArgs> = {}): StartArgs {
  return {
    type: 'recap_create',
    projectUri: '*',
    period: { label: 'last_7' },
    timeZone: 'UTC',
    ...extra,
  }
}

// The anchor template's defaults.signals are byte-equal to the orchestrator's
// DEFAULT_SIGNALS, so the untemplated default path resolves this exact set.
const DEFAULT_SIGNAL_SET: RecapSignal[] = [
  'assistant_final_turn',
  'commits',
  'cost',
  'errors_hooks',
  'open_questions',
  'task_results',
  'tool_summaries',
  'user_prompts',
]

describe('resolveRecipe', () => {
  test('no template -> the project-recap anchor, human audience, default signal set', () => {
    const r = resolveRecipe(makeArgs())
    expect(r.templateId).toBe(DEFAULT_TEMPLATE_ID)
    expect(r.template?.id).toBe(DEFAULT_TEMPLATE_ID)
    expect(r.audience).toBe('human')
    expect(r.optionFlags).toEqual({})
    expect(r.signals).toEqual(DEFAULT_SIGNAL_SET)
  })

  test('agent audience opts turn_internals in (untemplated default behaviour preserved)', () => {
    const r = resolveRecipe(makeArgs({ audience: 'agent' }))
    expect(r.audience).toBe('agent')
    expect(r.signals).toContain('turn_internals')
    // Everything else is still the anchor default set.
    const withoutInternals = r.signals.filter((s): s is RecapSignal => s !== 'turn_internals')
    expect(withoutInternals).toEqual(DEFAULT_SIGNAL_SET)
  })

  test('explicit args.signals win verbatim (hard user override), sorted', () => {
    const r = resolveRecipe(makeArgs({ signals: ['commits', 'cost'] as RecapSignal[] }))
    expect(r.signals).toEqual(['commits', 'cost'])
  })

  test('an unknown template id falls back to the default, but templateId stays self-describing', () => {
    const r = resolveRecipe(makeArgs({ template: 'does-not-exist' }))
    // The fallback yields the default template object...
    expect(r.template?.id).toBe(DEFAULT_TEMPLATE_ID)
    // ...and the recorded id resolves to the default (what was actually rendered).
    expect(r.templateId).toBe(DEFAULT_TEMPLATE_ID)
  })

  test('selecting the default template explicitly matches the implicit default', () => {
    const implicit = resolveRecipe(makeArgs())
    const explicit = resolveRecipe(makeArgs({ template: DEFAULT_TEMPLATE_ID }))
    expect(explicit.signals).toEqual(implicit.signals)
    expect(explicit.templateId).toBe(implicit.templateId)
    expect(explicit.audience).toBe(implicit.audience)
  })

  test('options on a no-option template resolve to empty flags (unknown keys ignored)', () => {
    const r = resolveRecipe(makeArgs({ options: { not_a_real_option: true } }))
    expect(r.optionFlags).toEqual({})
  })
})
