/**
 * SOTU per-project configuration (Phase 4) -- the opt-in flag + spend caps that
 * gate the PAID distill. The FREE floor (queue + git-fabric scan + live soft-lock
 * map) never reads this; only the scribe/reconcile fold does.
 *
 * Design (`plan-state-of-union.md` BUDGET section): `ProjectMeta.sotuEnabled` +
 * `sotuBudget {dailyUsd?, monthlyUsd?}`. Mission-control's `ProjectMeta` is not
 * built, so the canonical per-project store -- `ProjectSettings` (the same store
 * `lessonsEnabled` rides) -- is the real home. This module is the thin adapter:
 * the shape the engine consumes + the default resolver off ProjectSettings.
 *
 * The engine takes the resolver as an injectable dep (tests pass a stub), so the
 * gate is exercised without the broker's settings store.
 */

import type { SotuStakes, SotuTuning } from '../../shared/protocol'
import { getProjectSettings } from '../project-settings'
import { resolveBudget, resolveTuning } from './tuning'

/** The resolved SOTU config for one project. */
export interface SotuProjectConfig {
  /** Opt-in: false = FREE floor only, no LLM ever (design: "off = floor only"). */
  enabled: boolean
  /** The stakes tier (affordability proxy) that defaulted the budget, if set. */
  stakes?: SotuStakes
  /** Effective USD caps. Absent = no cap on that period (enabled-but-uncapped); an
   *  explicit cap wins, else the stakes-tier default fills in (Phase 7 / OPEN ITEM #5). */
  budget: { dailyUsd?: number; monthlyUsd?: number }
  /** The resolved distill tuning (defaults + the project's `sotuParams` overrides). */
  params: SotuTuning
}

export type ResolveSotuConfig = (projectUri: string) => SotuProjectConfig

/** Default resolver: read the project's `ProjectSettings`. Opt-in defaults OFF
 *  (no settings entry, or `sotuEnabled` unset/false -> disabled). The budget folds an
 *  explicit cap over the stakes-tier default (Phase 7); the tuning folds the project's
 *  `sotuParams` over the baked defaults. The opt-in flag is the real gate -- stakes
 *  only picks a budget DEFAULT, it never auto-enables (no surprise spend). */
export function defaultResolveSotuConfig(projectUri: string): SotuProjectConfig {
  const s = getProjectSettings(projectUri)
  const explicit = {
    ...(typeof s?.sotuBudgetDailyUsd === 'number' ? { dailyUsd: s.sotuBudgetDailyUsd } : {}),
    ...(typeof s?.sotuBudgetMonthlyUsd === 'number' ? { monthlyUsd: s.sotuBudgetMonthlyUsd } : {}),
  }
  return {
    enabled: s?.sotuEnabled === true,
    ...(s?.stakes ? { stakes: s.stakes } : {}),
    budget: resolveBudget(explicit, s?.stakes),
    params: resolveTuning(s?.sotuParams),
  }
}
