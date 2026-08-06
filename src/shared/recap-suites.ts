/**
 * RECAP MODEL SUITES -- named bundles of per-stage model choices.
 *
 * A recap runs up to three kinds of LLM call (map extraction, reduce synthesis,
 * oneshot synthesis) and the right model differs by what the recap is FOR. A
 * suite names that whole trade-off once, so callers pick an intent ("cheap",
 * "accurate") instead of hand-assembling three model slugs.
 *
 * Suites are DEFAULTS, not policy: every level below can be overridden (see
 * resolveSuiteId + the per-stage tuning slugs), and this registry lives in
 * `shared/` so the control panel can render the choice without an API call.
 *
 * ALL SLUGS BELOW ARE MEASURED, 2026-07-27. The real 93k-token reduce prompt
 * from a production nightly was replayed against seven models, gated on whether
 * the output actually parses, then judged blind by two models from different
 * families holding the complete 1051-item source-fact inventory:
 *
 *   opus-4.8    8.6   $0.894   clean            <- `accurate`
 *   glm-5.2     8.2   $0.091   clean            <- `cheap`, 90% less
 *   minimax-m3  6.8   $0.056   FABRICATES       <- rejected despite being cheapest
 *   gpt-5.1     5.6   $0.181   whole threads missing
 *   deepseek-v4-pro, kimi-k2.6  unparseable (no YAML frontmatter)
 *
 * Two results worth not re-learning: Opus 5 is NOT here because it is more
 * verbose than 4.8, overruns the 32k output cap and returns documents truncated
 * mid-sentence for 42% more money. And minimax-m3 was rejected despite winning
 * on price because it invented tool names, an endpoint and a test framework this
 * project does not use -- cheaper is not a defence for a durable record that
 * lies.
 *
 * QWEN, re-run 2026-08-06 (same prompt, same rubric, same two judges, with both
 * shipped suites in the field as calibration anchors). Both judges ranked both
 * Qwens BELOW both incumbents:
 *
 *   opus-4.8   9.2 / 8.8   $0.89          <- anchor
 *   glm-5.2    9.0 / 9.8   $0.091  223s   <- anchor
 *   qwen3.8-max 7.0 / 8.2  $0.279  419s   thin coverage, 1 fabrication
 *   qwen3.7-max 6.0 / 6.0  $0.126  113s   FABRICATES (both judges, 3-4 flags)
 *
 * qwen3.8-max is 3x the price of glm-5.2 and ~2x the latency for a strictly
 * worse document, so there is no niche for it in either suite. The mechanism is
 * visible in the token counts: it spent 24160 output tokens to emit 27.6KB of
 * text, so most of what we paid for was reasoning, not record -- and the
 * resulting doc drops whole threads the cheaper model kept.
 *
 * Method caveat for whoever re-runs this: the rubric orders the judges to spread
 * scores across the field, so absolute numbers DRIFT between rounds as the field
 * changes (glm-5.2 read 8.2 in the July round and 9.0/9.8 here). Only the
 * within-round ordering is load-bearing. Always include a shipped suite as an
 * anchor. Harness: `.claude/temp/reduce-ab/` (generate-qwen.ts + judge3.ts).
 */

/** Suite ids. `cheap` and `accurate` name the trade-off in the user's terms. */
export type RecapSuiteId = 'accurate' | 'cheap'

export const DEFAULT_SUITE_ID: RecapSuiteId = 'accurate'

export interface RecapSuite {
  id: RecapSuiteId
  label: string
  /** One line, shown in the picker + the MCP tool description. */
  description: string
  /** Per-stage OpenRouter slugs. */
  map: string
  reduce: string
  oneshot: string
  /** Measured synthesis cost for a typical nightly-sized recap, for the UI to
   *  show the trade-off honestly rather than making the user guess. */
  approxSynthesisUsd: number
}

/**
 * The MAP model is deliberately the SAME in every suite.
 *
 * Extraction is where a cheap model does its quiet damage: Haiku 4.5 was
 * measured at ~40% fewer extracted items than Sonnet 5 for 2x less money, and
 * because extractions are cached for 60 days a thin one poisons every recap
 * that touches that conversation for two months. The map stage is also only
 * ~$0.25/night since the cross-run cache landed, so there is almost nothing to
 * win. `cheap` buys its savings entirely from synthesis, where the output is
 * regenerable and the damage is not sticky.
 */
const MAP_MODEL = 'anthropic/claude-sonnet-5'

const SUITES: Record<RecapSuiteId, RecapSuite> = {
  accurate: {
    id: 'accurate',
    label: 'Accurate',
    description: 'Best synthesis quality (Opus 4.8). For recaps a person will read or that leave the team.',
    map: MAP_MODEL,
    reduce: 'anthropic/claude-opus-4.8',
    oneshot: 'anthropic/claude-opus-4.8',
    approxSynthesisUsd: 0.89,
  },
  cheap: {
    id: 'cheap',
    label: 'Cheap',
    description: 'Roughly 90% cheaper synthesis (GLM-5.2), slightly thinner coverage. For automated/background recaps.',
    map: MAP_MODEL,
    reduce: 'z-ai/glm-5.2',
    oneshot: 'z-ai/glm-5.2',
    approxSynthesisUsd: 0.09,
  },
}

export const SUITE_IDS = Object.keys(SUITES) as RecapSuiteId[]

export function isRecapSuiteId(v: unknown): v is RecapSuiteId {
  return typeof v === 'string' && v in SUITES
}

/** Look up a suite. Unknown/absent ids fall back to the default rather than
 *  throwing -- a bad suite name should not fail someone's recap. */
export function getSuite(id: string | undefined): RecapSuite {
  return isRecapSuiteId(id) ? SUITES[id] : SUITES[DEFAULT_SUITE_ID]
}

/** Every suite, for rendering a picker. */
export function listSuites(): RecapSuite[] {
  return SUITE_IDS.map(id => SUITES[id])
}

export interface SuiteResolutionInputs {
  /** Explicitly requested on the recap_create call (MCP param / UI picker). */
  requested?: string
  /** The project's configured default, if the user set one. */
  projectDefault?: string
  /** Machine-scheduled with nobody waiting on it (see isUnattendedRun). */
  unattended: boolean
  /** Rendered for someone outside the team. */
  customerFriendly?: boolean
}

export interface SuiteResolution {
  id: RecapSuiteId
  /** WHY this suite -- surfaced in logs and the recipe so a past recap can
   *  explain itself instead of looking arbitrary. */
  source: 'requested' | 'project-default' | 'customer-facing' | 'unattended' | 'default'
}

/**
 * Resolve which suite a run uses. Most specific wins:
 *
 *   1. requested        -- the caller named one, that is the answer
 *   2. customer-facing  -- overrides a project default: content leaving the team
 *                          is never quietly downgraded by a background setting
 *   3. project-default  -- the user's configured preference for this project
 *   4. unattended       -- machinery feeding the searchable layer, go cheap
 *   5. default          -- a person is waiting: accurate
 *
 * Per-stage `tuning.*Model` slugs sit ABOVE all of this and are applied by the
 * caller (see chunkModels) -- a raw slug is finer-grained than a suite.
 */
export function resolveSuiteId(inputs: SuiteResolutionInputs): SuiteResolution {
  if (isRecapSuiteId(inputs.requested)) return { id: inputs.requested, source: 'requested' }
  if (inputs.customerFriendly) return { id: 'accurate', source: 'customer-facing' }
  if (isRecapSuiteId(inputs.projectDefault)) return { id: inputs.projectDefault, source: 'project-default' }
  if (inputs.unattended) return { id: 'cheap', source: 'unattended' }
  return { id: DEFAULT_SUITE_ID, source: 'default' }
}
