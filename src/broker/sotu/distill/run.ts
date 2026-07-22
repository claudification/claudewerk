/**
 * SOTU distill runner (Phase 4) -- one fold of the queue into the chronicle.
 *
 * Order of operations, mirroring the design's `distillNow()`:
 *  1. GATE: project opt-in (off -> floor only, NO LLM ever) then the BUDGET gate
 *     (over cap -> keep the free floor, emit `sotu_budget_exhausted`, no LLM).
 *  2. DRAIN: new contributions since the last fold (watermark = lastDistillAt).
 *     Nothing new + not a forced reconcile -> a no-op refresh (no spend).
 *  3. SCRIBE fold (Haiku): fold the new items into the running chronicle.
 *  4. RECONCILE (Opus, when forced or on a big burst): re-ground the WHOLE
 *     chronicle against measured git truth, then apply deterministic decay.
 *  5. PERSIST: write chronicle + bundle (recap C+) + ledger, record spend, reset
 *     the trigger counters, broadcast `sotu_updated`. LOG EVERYTHING.
 *
 * Every LLM call flows through `runSotuLlmCall` so the COST-2 ledger records spend
 * on success AND failure; a parse failure keeps the PRIOR chronicle (never writes
 * garbage) but still records the cost it burned.
 */

import type { SotuBudgetExhausted, SotuUpdated } from '../../../shared/protocol'
import { readChronicle, writeChronicle } from '../chronicle'
import type { SotuProjectConfig } from '../config'
import { buildRecipe } from '../eval'
import { scoreGrounding } from '../grounding'
import { isExpired, readQueue } from '../queue'
import { overBudget, recordSpend, spendThisPeriod } from '../spend'
import { readState, updateState } from '../state'
import {
  type Chronicle,
  type Contribution,
  type GitFabric,
  SOTU_PIPELINE_VERSION,
  type SotuDistillMode,
} from '../types'
import { type DistillLeg, writeDistillBundle } from './bundle'
import { applyDecay } from './decay'
import { type ChatFn, RecapLedger, runSotuLlmCall } from './llm'
import { buildReconcilePrompt, buildScribePrompt, type ChronicleSections, parseChronicleOutput } from './prompts'

const SCRIBE_MAX_TOKENS = 4_000
const RECONCILE_MAX_TOKENS = 8_000
const SCRIBE_TIMEOUT_MS = 60_000
const RECONCILE_TIMEOUT_MS = 180_000

export interface DistillDeps {
  chat: ChatFn
  /** Broadcast a `sotu_updated` / `sotu_budget_exhausted` scoped to the project. */
  broadcast: (message: Record<string, unknown>, project: string) => void
  now?: () => number
  log?: (msg: string) => void
}

export interface RunDistillArgs {
  slug: string
  project: string
  config: SotuProjectConfig
  /** Read-triggered "wither on return": force the Opus re-ground + aggressive decay. */
  forceReconcile?: boolean
}

export type DistillStatus = 'distilled' | 'disabled' | 'budget' | 'noop' | 'error'

export interface DistillOutcome {
  status: DistillStatus
  mode?: SotuDistillMode
  costUsd?: number
  /** New items folded this run (drain count). */
  folded?: number
}

/** Run one distill. Pure orchestration over the file store + the injected chat fn;
 *  never throws (failures degrade to an `error` outcome with the prior chronicle). */
export async function runDistill(deps: DistillDeps, args: RunDistillArgs): Promise<DistillOutcome> {
  const now = deps.now?.() ?? Date.now()
  const log = deps.log ?? (() => {})
  const { slug, project, config } = args

  if (!config.enabled) {
    log(`[sotu] distill SKIP project=${project} -- disabled (free floor only)`)
    return { status: 'disabled' }
  }
  const spend = spendThisPeriod(slug, now)
  if (overBudget(spend, config.budget)) {
    deps.broadcast(
      { type: 'sotu_budget_exhausted', project, spend, budget: config.budget } satisfies SotuBudgetExhausted,
      project,
    )
    log(
      `[sotu] distill SKIP project=${project} -- budget exhausted ` +
        `(day $${spend.dailyUsd.toFixed(2)}/${capStr(config.budget.dailyUsd)}, ` +
        `month $${spend.monthlyUsd.toFixed(2)}/${capStr(config.budget.monthlyUsd)})`,
    )
    return { status: 'budget' }
  }

  const state = readState(slug)
  const allItems = readQueue(slug)
  const newItems = allItems.filter(c => !isExpired(c, now) && c.ts > state.lastDistillAt)
  if (newItems.length === 0 && !args.forceReconcile) {
    updateState(slug, s => ({ ...s, genAt: now, pendingContribs: 0 }))
    log(`[sotu] distill NOOP project=${project} -- no new contributions since last fold`)
    return { status: 'noop' }
  }

  const mode: SotuDistillMode =
    args.forceReconcile || state.pendingContribs >= config.params.reconcileBurst ? 'reconcile' : 'scribe'
  const live = allItems.filter(c => !isExpired(c, now))
  return execute(deps, args, { now, mode, newItems, live, gitFabric: latestGitFabric(allItems) })
}

interface ExecCtx {
  now: number
  mode: SotuDistillMode
  newItems: Contribution[]
  /** All non-expired contributions at distill time -- the input grounding scores against. */
  live: Contribution[]
  gitFabric?: GitFabric
}

/** The paid path: scribe fold, optional reconcile + decay, persist + broadcast. */
async function execute(deps: DistillDeps, args: RunDistillArgs, ctx: ExecCtx): Promise<DistillOutcome> {
  const log = deps.log ?? (() => {})
  const { slug, project } = args
  const prior = readChronicle(slug)
  const ledger = new RecapLedger()
  const startedAt = ctx.now
  const legs: { scribe?: DistillLeg; reconcile?: DistillLeg } = {}

  const tuning = args.config.params
  let sections: ChronicleSections = { now: prior.now, justDone: prior.justDone, narrative: prior.narrative }
  let failed: string | undefined
  try {
    sections = await runScribe(deps, ledger, sections, ctx, legs, tuning.scribeModel)
    if (ctx.mode === 'reconcile')
      sections = await runReconcile(deps, ledger, sections, ctx, legs, tuning.reconcileModel)
  } catch (err) {
    failed = err instanceof Error ? err.message : String(err)
    log(`[sotu] distill ERROR project=${project} mode=${ctx.mode} -- ${failed} (keeping prior chronicle)`)
  }

  const chronicle = buildChronicle(prior, sections, ctx, tuning.deadCutoffMs, failed)
  if (!failed) writeChronicle(slug, chronicle)
  const costUsd = ledger.totalCostUsd()
  persist(deps, args, ctx, { prior, chronicle, ledger, startedAt, legs, error: failed })

  const status: DistillStatus = failed ? 'error' : 'distilled'
  log(
    `[sotu] distill ${status.toUpperCase()} project=${project} mode=${ctx.mode} ` +
      `folded=${ctx.newItems.length} cost=$${costUsd.toFixed(4)} ` +
      `now=${chronicle.now.length} justDone=${chronicle.justDone.length}`,
  )
  return { status, mode: ctx.mode, costUsd, folded: ctx.newItems.length }
}

async function runScribe(
  deps: DistillDeps,
  ledger: RecapLedger,
  prior: ChronicleSections,
  ctx: ExecCtx,
  legs: { scribe?: DistillLeg },
  model: string,
): Promise<ChronicleSections> {
  const prompt = buildScribePrompt(prior, ctx.newItems)
  const raw = await runSotuLlmCall(deps.chat, ledger, 'scribe', {
    feature: 'sotu-distill',
    model,
    system: prompt.system,
    user: prompt.user,
    responseFormat: { type: 'json_object' },
    maxTokens: SCRIBE_MAX_TOKENS,
    timeoutMs: SCRIBE_TIMEOUT_MS,
    temperature: 0.2,
    retries: 2,
  })
  legs.scribe = { ...prompt, raw }
  return parseChronicleOutput(raw)
}

async function runReconcile(
  deps: DistillDeps,
  ledger: RecapLedger,
  scribed: ChronicleSections,
  ctx: ExecCtx,
  legs: { reconcile?: DistillLeg },
  model: string,
): Promise<ChronicleSections> {
  const prompt = buildReconcilePrompt(scribed, ctx.gitFabric)
  const raw = await runSotuLlmCall(deps.chat, ledger, 'reconcile', {
    feature: 'sotu-distill',
    model,
    system: prompt.system,
    user: prompt.user,
    responseFormat: { type: 'json_object' },
    maxTokens: RECONCILE_MAX_TOKENS,
    timeoutMs: RECONCILE_TIMEOUT_MS,
    temperature: 0.1,
    retries: 2,
  })
  legs.reconcile = { ...prompt, raw }
  return parseChronicleOutput(raw)
}

/** Assemble the chronicle to persist: the scribed/reconciled sections, stamped with
 *  version + generatedAt, with deterministic decay (git attach + prune) applied on a
 *  reconcile pass. On failure the PRIOR chronicle is returned (only genAt advances). */
function buildChronicle(
  prior: Chronicle,
  sections: ChronicleSections,
  ctx: ExecCtx,
  deadCutoffMs: number,
  failed?: string,
): Chronicle {
  if (failed) return { ...prior, generatedAt: ctx.now }
  const base: Chronicle = {
    now: sections.now,
    justDone: sections.justDone,
    narrative: sections.narrative,
    pipelineVersion: SOTU_PIPELINE_VERSION,
    generatedAt: ctx.now,
    ...(prior.git ? { git: prior.git } : {}),
  }
  return ctx.mode === 'reconcile' ? applyDecay(base, ctx.gitFabric, { now: ctx.now, deadCutoffMs }) : base
}

interface PersistCtx {
  prior: Chronicle
  chronicle: Chronicle
  ledger: RecapLedger
  startedAt: number
  legs: { scribe?: DistillLeg; reconcile?: DistillLeg }
  error?: string
}

/** Write the bundle, record spend, reset trigger counters, broadcast `sotu_updated`. */
function persist(deps: DistillDeps, args: RunDistillArgs, ctx: ExecCtx, p: PersistCtx): void {
  const { slug, project } = args
  const costUsd = p.ledger.totalCostUsd()
  // Pillar D: score the PRODUCED chronicle's citations against the input the fold saw
  // (the live queue at distill time). Only meaningful when a chronicle was written --
  // a failed distill keeps the prior chronicle, so skip grounding then.
  const grounding = p.error ? undefined : scoreGrounding(p.chronicle, ctx.live)
  writeDistillBundle(slug, ctx.now, {
    mode: ctx.mode,
    project,
    pipelineVersion: SOTU_PIPELINE_VERSION,
    startedAt: p.startedAt,
    completedAt: ctx.now,
    queuedItems: ctx.newItems,
    priorChronicle: p.prior,
    chronicle: p.chronicle,
    ledger: p.ledger.build(),
    recipe: buildRecipe(args.config, ctx.mode),
    ...(grounding ? { grounding } : {}),
    ...(ctx.gitFabric ? { gitFabric: ctx.gitFabric } : {}),
    ...(p.legs.scribe ? { scribe: p.legs.scribe } : {}),
    ...(p.legs.reconcile ? { reconcile: p.legs.reconcile } : {}),
    ...(p.error !== undefined ? { error: p.error } : {}),
  })
  recordSpend(slug, costUsd, ctx.now)
  updateState(slug, s => ({ ...s, lastDistillAt: ctx.now, genAt: ctx.now, pendingContribs: 0 }))
  deps.broadcast(
    { type: 'sotu_updated', project, generatedAt: ctx.now, mode: ctx.mode, costUsd } satisfies SotuUpdated,
    project,
  )
}

/** The most recent git-fabric snapshot in the queue (reconcile re-grounds against it). */
function latestGitFabric(items: Contribution[]): GitFabric | undefined {
  for (let i = items.length - 1; i >= 0; i--) {
    const c = items[i]
    if (c?.kind === 'git_scan') return c.git
  }
  return undefined
}

function capStr(cap: number | undefined): string {
  return cap === undefined ? '∞' : `$${cap.toFixed(2)}`
}
