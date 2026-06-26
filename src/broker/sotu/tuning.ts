/**
 * SOTU distill tuning -- the ONE home for the model/cutoff/trigger defaults and the
 * per-stakes budget defaults (Phase 7).
 *
 * Before Phase 7 these constants were scattered across `engine.ts` (trigger
 * constants), `distill/run.ts` (models + reconcile burst), and `distill/decay.ts`
 * (the dead cutoff). Phase 7 makes them per-project editable (the benevolent-gated
 * tuning bag on `ProjectSettings.sotuParams`), so they collapse to ONE resolved
 * `SotuTuning` -- defaults here, overridden per project, recorded in each distill's
 * recipe (recap Pillar D mirror).
 *
 * BUDGET DEFAULT NUMBERS (design OPEN ITEM #5): the per-stakes daily/monthly caps
 * below are FIRST GUESSES -- tune against real fleet cost once the ledger reports
 * SOTU spend. Stakes is the affordability proxy: it picks the DEFAULT budget when a
 * project sets no explicit cap; it never auto-enables SOTU (opt-in stays explicit).
 */

import type { SotuStakes, SotuTuning, SotuTuningOverrides } from '../../shared/protocol'

/** The baked tuning defaults -- the values that ran before Phase 7 made them
 *  per-project. A project's `sotuParams` overrides any subset of these. */
export const SOTU_TUNING_DEFAULTS: SotuTuning = {
  scribeModel: 'anthropic/claude-haiku-4.5',
  reconcileModel: 'anthropic/claude-opus-4.8',
  reconcileBurst: 25,
  minIntervalMs: 5 * 60_000,
  burstThreshold: 10,
  quietSettleMs: 90_000,
  staleOnReadMs: 45 * 60_000,
  deadCutoffMs: 48 * 60 * 60_000,
}

/** The numeric tuning fields -- the only ones a `> 0` guard applies to (the two
 *  model fields are strings). Used by the override sanitizer. */
const NUMERIC_KEYS: ReadonlyArray<keyof SotuTuning> = [
  'reconcileBurst',
  'minIntervalMs',
  'burstThreshold',
  'quietSettleMs',
  'staleOnReadMs',
  'deadCutoffMs',
]

/** Resolve the effective tuning: defaults with the project's overrides folded in.
 *  An override is honored only when well-formed (a non-empty model string, or a
 *  finite positive number) so a garbage settings entry can never NaN the engine. */
export function resolveTuning(overrides?: SotuTuningOverrides): SotuTuning {
  if (!overrides) return { ...SOTU_TUNING_DEFAULTS }
  const out: SotuTuning = { ...SOTU_TUNING_DEFAULTS }
  if (typeof overrides.scribeModel === 'string' && overrides.scribeModel.trim()) {
    out.scribeModel = overrides.scribeModel.trim()
  }
  if (typeof overrides.reconcileModel === 'string' && overrides.reconcileModel.trim()) {
    out.reconcileModel = overrides.reconcileModel.trim()
  }
  const nums = out as unknown as Record<string, number>
  for (const k of NUMERIC_KEYS) {
    const v = overrides[k]
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) nums[k] = v
  }
  return out
}

/** Per-stakes default budget (USD). FIRST GUESSES (design OPEN ITEM #5) -- generous
 *  on income/client work, modest on side projects, tiny on experiments. These apply
 *  only when a project sets NO explicit cap; an explicit `sotuBudget*` always wins. */
export const STAKES_BUDGET_DEFAULTS: Record<SotuStakes, { dailyUsd: number; monthlyUsd: number }> = {
  'main-income': { dailyUsd: 5, monthlyUsd: 40 },
  client: { dailyUsd: 5, monthlyUsd: 40 },
  side: { dailyUsd: 1, monthlyUsd: 8 },
  experiment: { dailyUsd: 0.25, monthlyUsd: 2 },
}

/** Resolve the effective budget: an explicit cap wins per-period; an absent cap
 *  falls back to the stakes-tier default; no stakes + no cap = unbounded (the opt-in
 *  flag is the real gate, not the budget). Each period resolves independently, so a
 *  project can set only a daily cap and inherit the stakes monthly default. */
export function resolveBudget(
  explicit: { dailyUsd?: number; monthlyUsd?: number },
  stakes?: SotuStakes,
): { dailyUsd?: number; monthlyUsd?: number } {
  const def = stakes ? STAKES_BUDGET_DEFAULTS[stakes] : undefined
  const daily = typeof explicit.dailyUsd === 'number' ? explicit.dailyUsd : def?.dailyUsd
  const monthly = typeof explicit.monthlyUsd === 'number' ? explicit.monthlyUsd : def?.monthlyUsd
  return {
    ...(typeof daily === 'number' ? { dailyUsd: daily } : {}),
    ...(typeof monthly === 'number' ? { monthlyUsd: monthly } : {}),
  }
}
