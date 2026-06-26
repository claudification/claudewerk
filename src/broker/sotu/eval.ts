/**
 * SOTU distill eval surface (Phase 7) -- the recap Pillar D mirror.
 *
 * Every distill records a self-describing RECIPE (the resolved tuning + budget/stakes
 * context + mode) and a GROUNDING score (the deterministic bard-lying detector) in its
 * bundle manifest. This module:
 *   - `buildRecipe` -- assembles the recipe from the resolved config + the mode, so a
 *     $X distill is reproducible (the actual models/cutoffs/trigger constants used).
 *   - `readDistillEvals` -- scans a project's `distills/<ts>/manifest.json` and returns
 *     the recent evals (recipe + cost + grounding) newest-first, so a benevolent agent
 *     QCs SOTU quality/cost across tuning variants without re-running anything.
 *
 * recap persists its recipe to an `args_json` SQLite column; SOTU has no SQLite (the
 * whole store is files), so the bundle manifest IS the args_json -- plus a standalone
 * `recipe.json` for a cheap scan that never has to parse the full manifest.
 */

import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { SheafGrounding, SotuDistillEval, SotuRecipe } from '../../shared/protocol'
import type { SotuProjectConfig } from './config'
import { distillsRoot } from './paths'
import { SOTU_PIPELINE_VERSION, type SotuDistillMode } from './types'

/** Assemble the self-describing recipe for a distill: the RESOLVED tuning actually
 *  used (flat, like recap's args_json) + the budget/stakes context + the mode. */
export function buildRecipe(config: SotuProjectConfig, mode: SotuDistillMode): SotuRecipe {
  return {
    ...config.params,
    pipelineVersion: SOTU_PIPELINE_VERSION,
    mode,
    ...(config.stakes ? { stakes: config.stakes } : {}),
    ...(typeof config.budget.dailyUsd === 'number' ? { budgetDailyUsd: config.budget.dailyUsd } : {}),
    ...(typeof config.budget.monthlyUsd === 'number' ? { budgetMonthlyUsd: config.budget.monthlyUsd } : {}),
  }
}

/** The eval fields a manifest carries (the subset `readDistillEvals` reads back). */
interface ManifestEval {
  mode?: SotuDistillMode
  recipe?: SotuRecipe
  grounding?: SheafGrounding
  folded?: number
  error?: string
  cost?: { totalCostUsd?: number }
}

/** Load + validate one `distills/<ts>/manifest.json`, or null if it is unreadable or
 *  pre-Phase-7 (no recipe). Splits the guard out of the row builder to keep each
 *  function flat. `ts` comes from the dir name. */
function loadManifest(
  root: string,
  dirName: string,
): { ts: number; m: ManifestEval & { mode: SotuDistillMode; recipe: SotuRecipe } } | null {
  const ts = Number(dirName)
  if (!Number.isFinite(ts)) return null
  try {
    const m = JSON.parse(readFileSync(join(root, dirName, 'manifest.json'), 'utf8')) as ManifestEval
    return m.recipe && m.mode ? { ts, m: { ...m, mode: m.mode, recipe: m.recipe } } : null
  } catch {
    return null
  }
}

/** Build the eval row from a validated manifest -- optional fields spread only when present. */
function toEval(ts: number, m: ManifestEval & { mode: SotuDistillMode; recipe: SotuRecipe }): SotuDistillEval {
  return {
    ts,
    mode: m.mode,
    costUsd: m.cost?.totalCostUsd ?? 0,
    recipe: m.recipe,
    ...(typeof m.folded === 'number' ? { folded: m.folded } : {}),
    ...(m.grounding ? { grounding: m.grounding } : {}),
    ...(m.error !== undefined ? { error: m.error } : {}),
  }
}

/** Read a project's recent distill evals (recipe + cost + grounding), newest first.
 *  Best-effort: an unreadable dir is skipped, never thrown. `limit` clamps the page. */
export function readDistillEvals(slug: string, limit = 20): SotuDistillEval[] {
  const root = distillsRoot(slug)
  let names: string[]
  try {
    names = readdirSync(root)
  } catch {
    return []
  }
  const evals: SotuDistillEval[] = []
  for (const name of names) {
    const loaded = loadManifest(root, name)
    if (loaded) evals.push(toEval(loaded.ts, loaded.m))
  }
  evals.sort((a, b) => b.ts - a.ts)
  return evals.slice(0, Math.max(1, limit))
}
