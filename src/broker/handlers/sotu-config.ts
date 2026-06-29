/**
 * SOTU tuning + eval wire handlers (Phase 7) -- the benevolent-gated agent surface
 * for QC-ing distill quality/cost across tuning variants:
 *   - `sotu_configure_request` -- read AND optionally edit a project's SOTU config
 *     (enabled / stakes / budget caps / tuning params). A write persists to
 *     `ProjectSettings`; the reply always returns the resolved config AFTER the write.
 *   - `sotu_eval_request` -- list a project's recent distill evals (recipe + cost +
 *     grounding) so a benevolent agent compares variants without re-running anything.
 *
 * Both are benevolent-gated for agent-host callers (recap Pillar B) and echo
 * `requestId`. No new UI -- this is an agent/admin-facing tuning surface (the design's
 * "benevolent-gated like recap tuning params"); the panel toggle is deferred.
 */

import type {
  ProjectSettings,
  SotuConfigureResult,
  SotuConfigView,
  SotuEvalResult,
  SotuStakes,
  SotuTuningOverrides,
} from '../../shared/protocol'
import type { HandlerContext, MessageData } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { getProjectSettings, setProjectSettings } from '../project-settings'
import { defaultResolveSotuConfig } from '../sotu/config'
import { readDistillEvals } from '../sotu/eval'
import { projectSlug } from '../sotu/paths'
import { echoOf, resolveReadProject, trustError } from './sotu-shared'

const VALID_STAKES = new Set<SotuStakes>(['main-income', 'client', 'side', 'experiment'])

/** The tuning keys a `sotu_configure` write accepts (the `SotuTuning` set), each with
 *  the validity test + normalizer for its stored value. Data-driven so the merge is
 *  one flat loop. A model is a non-empty trimmed string; a constant is a positive
 *  finite number. */
const PARAM_SPEC: ReadonlyArray<{
  key: keyof SotuTuningOverrides
  norm: (v: number | string) => number | string | null
}> = [
  { key: 'scribeModel', norm: normModel },
  { key: 'reconcileModel', norm: normModel },
  { key: 'reconcileBurst', norm: normNum },
  { key: 'minIntervalMs', norm: normNum },
  { key: 'burstThreshold', norm: normNum },
  { key: 'quietSettleMs', norm: normNum },
  { key: 'staleOnReadMs', norm: normNum },
  { key: 'deadCutoffMs', norm: normNum },
]

/** Normalized model string, or null when not a usable model. */
function normModel(v: number | string): string | null {
  return typeof v === 'string' && v.trim() ? v.trim() : null
}

/** The number when finite + positive, else null. */
function normNum(v: number | string): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : null
}

/** Assemble the config view a `sotu_configure` reply returns: the resolved config
 *  (defaults + overrides) plus the raw overrides the project actually stores. */
function buildConfigView(project: string): SotuConfigView {
  const config = defaultResolveSotuConfig(project)
  return {
    enabled: config.enabled,
    ...(config.stakes ? { stakes: config.stakes } : {}),
    budget: config.budget,
    tuning: config.params,
    overrides: getProjectSettings(project)?.sotuParams ?? {},
  }
}

/** Merge a params patch onto the stored overrides: a `null` clears a key, a valid
 *  value sets it, junk is dropped. Returns undefined when the result is empty (so the
 *  settings entry drops the `sotuParams` key rather than storing `{}`). */
function mergeParams(
  existing: SotuTuningOverrides | undefined,
  patch: Record<string, number | string | null>,
): SotuTuningOverrides | undefined {
  const out: Record<string, number | string> = { ...(existing ?? {}) }
  for (const { key, norm } of PARAM_SPEC) {
    if (!(key in patch)) continue
    const v = patch[key]
    const normalized = v === null ? null : norm(v)
    if (normalized === null) delete out[key]
    else out[key] = normalized
  }
  return Object.keys(out).length ? (out as SotuTuningOverrides) : undefined
}

/** Apply the mutating fields of a configure request to `ProjectSettings`. Only the
 *  present fields change; an absent field is left untouched. Returns whether anything
 *  was written (a pure read passes no mutating fields). */
function applyWrite(project: string, data: MessageData): boolean {
  const update: Partial<ProjectSettings> = {}
  if (typeof data.enabled === 'boolean') update.sotuEnabled = data.enabled
  if (typeof data.stakes === 'string' && VALID_STAKES.has(data.stakes as SotuStakes)) {
    update.stakes = data.stakes as SotuStakes
  }
  if ('budgetDailyUsd' in data) update.sotuBudgetDailyUsd = numOrClear(data.budgetDailyUsd)
  if ('budgetMonthlyUsd' in data) update.sotuBudgetMonthlyUsd = numOrClear(data.budgetMonthlyUsd)
  if (data.params && typeof data.params === 'object') {
    update.sotuParams = mergeParams(getProjectSettings(project)?.sotuParams, data.params as Record<string, never>)
  }
  if (Object.keys(update).length === 0) return false
  // setProjectSettings strips undefined values (clears a cap); sotuParams=undefined drops the key.
  setProjectSettings(project, update)
  return true
}

/** A finite positive number stays; null / anything else clears the cap (undefined,
 *  which `setProjectSettings` strips). */
function numOrClear(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : undefined
}

function sotuConfigure(ctx: HandlerContext, data: MessageData): void {
  const echo = echoOf(data)
  const fail = (error: string): void => {
    ctx.reply({
      type: 'sotu_configure_result',
      requestId: echo.requestId ?? '',
      ok: false,
      error,
    } satisfies SotuConfigureResult)
  }
  const denied = trustError(ctx)
  if (denied) {
    fail(denied)
    return
  }
  const project = resolveReadProject(ctx, data)
  if (!project) {
    fail('no resolvable project')
    return
  }
  const wrote = applyWrite(project, data)
  const config = buildConfigView(project)
  if (wrote)
    ctx.log.info(`[sotu] sotu_configure project=${project} enabled=${config.enabled} stakes=${config.stakes ?? '-'}`)
  ctx.reply({
    type: 'sotu_configure_result',
    requestId: echo.requestId ?? '',
    ok: true,
    config,
  } satisfies SotuConfigureResult)
}

function sotuEval(ctx: HandlerContext, data: MessageData): void {
  const echo = echoOf(data)
  const fail = (error: string): void => {
    ctx.reply({ type: 'sotu_eval_result', requestId: echo.requestId ?? '', ok: false, error } satisfies SotuEvalResult)
  }
  const denied = trustError(ctx)
  if (denied) {
    fail(denied)
    return
  }
  const project = resolveReadProject(ctx, data)
  if (!project) {
    fail('no resolvable project')
    return
  }
  const limit = typeof data.limit === 'number' && data.limit > 0 ? Math.min(100, Math.floor(data.limit)) : 20
  const evals = readDistillEvals(projectSlug(project), limit)
  ctx.reply({ type: 'sotu_eval_result', requestId: echo.requestId ?? '', ok: true, evals } satisfies SotuEvalResult)
}

export function registerSotuConfigHandlers(): void {
  registerHandlers({ sotu_configure_request: sotuConfigure, sotu_eval_request: sotuEval }, AGENT_HOST_ONLY)
}

// Consumed by the dashboard WS handler (sotu-dashboard.ts).
export { applyWrite, buildConfigView }
