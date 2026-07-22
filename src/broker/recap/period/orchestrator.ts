import { createHash } from 'node:crypto'
import type {
  RecapAudience,
  RecapCreateMessage,
  RecapLedgerStage,
  RecapSignal,
  RecapTuning,
} from '../../../shared/protocol'
import { isRecapInFlight } from '../../../shared/protocol'
import type { StoreDriver } from '../../store/types'
import { type ChatRequest, chat } from '../shared/openrouter-client'
import type { NormalizedUsage } from '../shared/pricing'
import {
  AGENT_TEMPLATE_ID,
  DEFAULT_TEMPLATE_ID,
  loadTemplates,
  pickTemplate,
  type RecapTemplate,
  resolveOptionFlags,
  resolveTemplateSignals,
} from '../templates'
import { RECAP_PIPELINE_VERSION, type RecapBundleCallPrompt, type RecapBundleWriter } from './bundle'
import { buildMapPrompt, MapParseError, parseMapOutput } from './chunk/map-prompt'
import { makeEmptyMetadata, mergeMetadata } from './chunk/merge'
import {
  DEFAULT_CHUNK_SIZE_CHARS,
  DEFAULT_CHUNK_THRESHOLD_CHARS,
  DEFAULT_CHUNK_THRESHOLD_CONVS,
  shouldChunk,
  splitIntoChunks,
} from './chunk/split'
import { buildSynthesizePrompt } from './chunk/synthesize-prompt'
import {
  overallDeadlineMs,
  RECAP_MAP_TIMEOUT_MS,
  RECAP_SYNTHESIS_TIMEOUT_MS,
  RECAP_TIMEOUT_RETRIES,
  withDeadline,
} from './deadline'
import {
  gatherCommitsStub,
  gatherContention,
  gatherConversations,
  gatherCost,
  gatherErrors,
  gatherForgotten,
  gatherOpenQuestions,
  gatherTasks,
  gatherToolUse,
  gatherTranscripts,
  type PeriodScope,
  resolveProjectScope,
} from './gather'
import type { CommitDigest } from './gather/types'
import { RecapLedger } from './ledger'
import { chunkModels, pickModel } from './llm/escalate'
import { buildPrompt, type PresentationSelection, type PromptInputs, swapInstructions } from './llm/prompt-builder'
import { createProgressEmitter, type ProgressBroadcaster, type ProgressEmitter } from './progress'
import { buildRecapDigest } from './render/digest'
import { renderFinalMarkdown } from './render/markdown'
import { buildFtsFields, denormalizeTags } from './render/metadata'
import { type ParsedRecap, parseRecapOutput, type RecapMetadata, RecapParseError } from './render/parse-recap'
import { type ResolvedPeriod, resolvePeriod } from './resolve-period'
import { type PeriodRecapStore, rowToRecapMeta } from './store'

const DEFAULT_SIGNALS: RecapSignal[] = [
  'user_prompts',
  'assistant_final_turn',
  'commits',
  'task_results',
  'tool_summaries',
  'errors_hooks',
  'cost',
  'open_questions',
  'agent_status',
]
const CACHE_WINDOW_MS = 5 * 60 * 1000

export interface OrchestratorDeps {
  store: PeriodRecapStore
  brokerStore: StoreDriver
  broadcaster: ProgressBroadcaster
  /** Resolves the project URI -> rolled-up child URIs (worktrees etc). */
  expandProjectScope?: (projectUri: string) => string[]
  /** Override now() for tests. */
  now?: () => number
  /** OpenRouter API key override (otherwise reads OPENROUTER_API_KEY env). */
  apiKey?: string
  /** Project label rendering (e.g. last path segment). */
  projectLabel?: (projectUri: string) => string
  /** Real commit gathering via the sentinel git_log RPC. Injected by the broker
   *  (which owns the sentinel connections). Absent in tests -> the empty stub
   *  is used and the recap reports "no git data available". */
  gatherCommits?: (scope: PeriodScope) => Promise<CommitDigest>
  /** Deliver a recap-completed system channel message into a conversation.
   *  Provided by the broker (inform_on_complete). No-op if absent. */
  informConversation?: (conversationId: string, msg: { recapId: string; text: string }) => void
  /** Pillar C+: on-disk run-artifact bundle writer (incremental, best-effort).
   *  Absent in tests -> the run proceeds without a bundle. */
  bundle?: RecapBundleWriter
}

export interface StartArgs extends RecapCreateMessage {
  createdBy?: string
  /** Conversation to notify on completion. Resolved broker-side from the
   *  caller's WS connection when inform_on_complete is set. */
  informConversationId?: string
}

export interface StartResult {
  recapId: string
  cached: boolean
}

// fallow-ignore-next-line complexity
export async function startRecap(deps: OrchestratorDeps, args: StartArgs): Promise<StartResult> {
  const period = resolvePeriod(args.period, args.timeZone, deps.now?.())
  // Resolve the full presentation recipe ONCE (template + option flags + signal
  // set + audience). Deterministic from args, so runRecap re-derives the same
  // recipe without threading state across the async boundary.
  const recipe = resolveRecipe(args)
  const { audience, signals } = recipe
  // audience + customerFriendly + template + resolved options are folded into the
  // cache key: a human vs agent recap, a sanitized vs raw recap, and a recap
  // rendered with a DIFFERENT template OR different option toggles are different
  // documents for the same project+period+signals -- they must not collide in the
  // 5-min cache.
  const signalsHash = recapCacheKey({
    projectUri: args.projectUri,
    periodStart: period.start,
    periodEnd: period.end,
    audience,
    customerFriendly: args.customerFriendly ?? false,
    ...(args.instructions?.trim() ? { instructions: args.instructions } : {}),
    signals,
    template: recipe.templateId,
    options: recipe.optionFlags,
  })

  if (!args.force) {
    const hit = deps.store.findCacheHit({
      projectUri: args.projectUri,
      periodStart: period.start,
      periodEnd: period.end,
      signalsHash,
      freshSinceMs: CACHE_WINDOW_MS,
    })
    if (hit) return { recapId: hit.id, cached: true }
  }

  const recapId = `recap_${nanoid(12)}`
  deps.store.insert({
    id: recapId,
    projectUri: args.projectUri,
    periodLabel: args.period.label,
    periodStart: period.start,
    periodEnd: period.end,
    timeZone: args.timeZone,
    audience,
    informConversationId: args.informConversationId,
    signalsJson: JSON.stringify(signals),
    signalsHash,
    createdAt: Date.now(),
    createdBy: args.createdBy,
  })

  scheduleRun(deps, recapId, args, period, args.timeZone)
  return { recapId, cached: false }
}

function scheduleRun(
  deps: OrchestratorDeps,
  recapId: string,
  args: StartArgs,
  period: ResolvedPeriod,
  timeZone: string,
  reuseMap?: (index: number) => RecapMetadata | null,
): void {
  setImmediate(() => {
    // The ledger lives at this scope so the failure path can persist whatever
    // cost was already burned (record-on-failure) -- the runLlmCall wrapper
    // also flushes it incrementally, but this guarantees the final state.
    const ledger = new RecapLedger()
    const scheduledAt = Date.now()
    runRecap(deps, recapId, args, period, timeZone, ledger, reuseMap).catch(err => {
      const priorPhase = deps.store.get(recapId)?.phase ?? '?'
      console.error(
        `[recap] ${recapId} FAILED after ${Math.round((Date.now() - scheduledAt) / 1000)}s at phase=${priorPhase}: ${describe(err)}`,
      )
      const built = ledger.build()
      const failedAt = Date.now()
      deps.store.update(recapId, {
        status: 'failed',
        error: describe(err),
        // Stamp completedAt on the STORE row, not just the bundle manifest. It's
        // the terminal-time the widget's recency filter + history modal both read;
        // omitting it left every failed recap with completed_at=null, so a stale
        // in-flight card could never be reconciled to 'failed' after a broker
        // restart (it sat forever as a zombie 'rendering'). reapStale already does
        // this right -- match it here.
        completedAt: failedAt,
        ledgerJson: JSON.stringify(built),
        inputTokens: built.summary.totalInputTokens,
        outputTokens: built.summary.totalOutputTokens,
        llmCostUsd: built.summary.totalCostUsd,
      })
      // Pillar C+: record the failure on the bundle too (no-op if the run died
      // before begin() ever created the dir).
      deps.bundle?.updateManifest(recapId, {
        status: 'failed',
        error: describe(err),
        completedAt: failedAt,
        cost: built.summary,
      })
      deps.broadcaster.broadcast({
        type: 'recap_progress',
        recapId,
        status: 'failed',
        progress: 100,
        phase: 'failed',
        log: { level: 'error', message: describe(err), ts: Date.now() },
      })
      // inform_on_complete: a caller waiting on a push must not be left
      // hanging when the run fails -- tell it the outcome either way.
      if (args.informConversationId && deps.informConversation) {
        deps.informConversation(args.informConversationId, {
          recapId,
          text: `Recap ${recapId} failed: ${describe(err)}`,
        })
      }
    })
  })
}

// ---------------------------------------------------------------------------
// Pillar C++ -- resumable stage replay (recap_regenerate)
// ---------------------------------------------------------------------------

export type RegenerateFrom = 'synthesize' | 'render' | 'html'
export type RegenerateMode = 'fork' | 'in-place'

export interface RegenerateArgs {
  recapId: string
  from: RegenerateFrom
  /** fork (default) -> new recapId, copies upstream artifacts; in-place -> refine
   *  the same recap. fork never destroys a paid artifact. */
  mode?: RegenerateMode
  /** Optional synthesize-stage model override (the eval-harness lever: try a new
   *  reduce/oneshot model on the SAME merged JSON without re-paying extraction). */
  model?: string
  /** Optional refinement-instructions override. undefined = reuse the source's
   *  (manifest); a string = override (empty clears). Applied at synthesize only. */
  instructions?: string
  /** Optional human label for the resulting variant (shown in the fork switcher). */
  variantLabel?: string
  /** Optional synthesize-stage sampling overrides. */
  temperature?: number
  maxTokens?: number
  createdBy?: string
}

export interface RegenerateResult {
  recapId: string
  sourceRecapId: string
  mode: RegenerateMode
  from: RegenerateFrom
}

/**
 * Re-run a recap from a downstream stage using its on-disk bundle (Pillar C+),
 * skipping the expensive upstream work:
 *   - from='synthesize': one Opus call on the SAVED merged JSON (chunked) or the
 *     SAVED oneshot prompt -- the $$ map extraction is NOT re-paid.
 *   - from='render'/'html': ZERO LLM cost -- re-parse the saved final response and
 *     re-render markdown + digest (gather is local/cheap, no model call).
 *
 * VERSION-GATED: refuses when the bundle's pipelineVersion no longer matches the
 * current pipeline, rather than silently stitching mismatched stages into garbage.
 * Validation throws synchronously so the caller sees the error immediately; the
 * actual re-run is scheduled in the background (like startRecap), returning the
 * target recapId right away.
 */
// fallow-ignore-next-line complexity
export function regenerateRecap(deps: OrchestratorDeps, args: RegenerateArgs): RegenerateResult {
  const src = deps.store.get(args.recapId)
  if (!src) throw new Error(`recap ${args.recapId} not found`)
  if (!deps.bundle) throw new Error('run-artifact bundles are not enabled on this broker')
  const manifest = deps.bundle.readManifest(args.recapId)
  if (!manifest) {
    throw new Error(`recap ${args.recapId} has no run-artifact bundle (predates Pillar C+); create a fresh recap`)
  }
  if (manifest.pipelineVersion !== RECAP_PIPELINE_VERSION) {
    throw new Error(
      `pipeline version mismatch for ${args.recapId} (bundle v${manifest.pipelineVersion}, current v${RECAP_PIPELINE_VERSION}); refusing to stitch mismatched stages -- create a fresh recap`,
    )
  }
  // Reachability check up front (synchronous error beats a background failure).
  if (args.from === 'synthesize') {
    const haveMerged = deps.bundle.readMerged(args.recapId) != null
    const haveOneshotPrompt = deps.bundle.readStagePrompt(args.recapId, 'oneshot') != null
    if (!haveMerged && !haveOneshotPrompt) {
      throw new Error(`recap ${args.recapId} has no merged JSON or oneshot prompt to synthesize from`)
    }
  } else if (deps.bundle.readFinalResponse(args.recapId) == null) {
    throw new Error(`recap ${args.recapId} has no saved final response to re-render`)
  }

  const mode: RegenerateMode = args.mode ?? 'fork'
  const targetId = mode === 'fork' ? `recap_${nanoid(12)}` : src.id
  if (mode === 'fork') {
    deps.store.insert({
      id: targetId,
      projectUri: src.projectUri,
      periodLabel: src.periodLabel,
      periodStart: src.periodStart,
      periodEnd: src.periodEnd,
      timeZone: src.timeZone,
      audience: src.audience,
      signalsJson: src.signalsJson,
      signalsHash: src.signalsHash,
      createdAt: Date.now(),
      ...(args.createdBy ? { createdBy: args.createdBy } : {}),
    })
    deps.bundle.forkUpstream(src.id, targetId)
  }
  // Resolve the effective refinement recipe for this variant: start from the
  // source's persisted recipe, then apply any override the caller supplied.
  // Persisted to BOTH the row's args_json (cheap list-level display of the
  // variant name) and the manifest (regenerate + doc prefill re-read it).
  const instructionsProvided = args.instructions !== undefined
  const effInstructions = instructionsProvided ? args.instructions?.trim() || undefined : manifest.instructions
  const srcRecipe = (jsonParseOr(src.argsJson) ?? {}) as Record<string, unknown>
  const effRecipe: Record<string, unknown> = { ...srcRecipe }
  if (args.variantLabel !== undefined) {
    const label = args.variantLabel.trim()
    if (label) effRecipe.variantLabel = label
    else delete effRecipe.variantLabel
  }
  if (args.model) effRecipe.model = args.model
  if (args.temperature !== undefined) effRecipe.temperature = args.temperature
  if (args.maxTokens !== undefined) effRecipe.maxTokens = args.maxTokens
  if (instructionsProvided) {
    if (effInstructions) effRecipe.instructions = effInstructions
    else delete effRecipe.instructions
  }

  // Flip the target row to 'rendering' synchronously so observers (and an
  // in-place refine of an already-'done' recap) see the regenerate in flight
  // rather than a stale terminal status.
  deps.store.update(targetId, { status: 'rendering', progress: 0, error: null, argsJson: JSON.stringify(effRecipe) })
  deps.bundle.updateManifest(targetId, {
    status: 'rendering',
    recipe: effRecipe,
    ...(instructionsProvided ? { instructions: effInstructions ?? '' } : {}),
    regenerate: { from: args.from, mode, sourceRecapId: src.id, at: Date.now() },
  })

  const ledger = new RecapLedger()
  setImmediate(() => {
    runRegenerate(deps, targetId, src, manifest, args, ledger).catch(err => {
      console.error(`[recap] regenerate failed for ${targetId} (from ${src.id}):`, err)
      const built = ledger.build()
      const failedAt = Date.now()
      deps.store.update(targetId, {
        status: 'failed',
        error: describe(err),
        // Stamp completedAt on the store row too (see the scheduleRun catch above
        // for why a null completed_at strands the widget card as a zombie).
        completedAt: failedAt,
        ledgerJson: JSON.stringify(built),
        inputTokens: built.summary.totalInputTokens,
        outputTokens: built.summary.totalOutputTokens,
        llmCostUsd: built.summary.totalCostUsd,
      })
      deps.bundle?.updateManifest(targetId, {
        status: 'failed',
        error: describe(err),
        completedAt: failedAt,
        cost: built.summary,
      })
      deps.broadcaster.broadcast({
        type: 'recap_progress',
        recapId: targetId,
        status: 'failed',
        progress: 100,
        phase: 'failed',
        log: { level: 'error', message: describe(err), ts: Date.now() },
      })
    })
  })

  return { recapId: targetId, sourceRecapId: src.id, mode, from: args.from }
}

// ---------------------------------------------------------------------------
// G3 -- resume-from-map (don't re-pay the chunks already extracted)
// ---------------------------------------------------------------------------

export interface ResumeResult {
  recapId: string
  resumeCount: number
  /** Chunks reusable from the bundle (won't be re-paid). */
  reusableChunks: number
  totalChunks: number
}

/** A recap can be resumed at most this many times before it's permanently
 *  failed -- a cost guard against a forever-broken recap (dialog: max 2). */
export const MAX_RESUME_ATTEMPTS = 2

/**
 * Resume an interrupted / partial / failed CHUNKED recap from its on-disk bundle:
 * re-gather + re-split (deterministic -- same chunkSize -> same boundaries), reuse
 * every persisted chunk extraction, re-run ONLY the missing chunks, then merge +
 * reduce + finalize. The expensive map work already paid is NOT re-paid. Capped
 * at MAX_RESUME_ATTEMPTS. Validates synchronously; runs in the background.
 */
// fallow-ignore-next-line complexity
export function resumeRecap(deps: OrchestratorDeps, recapId: string): ResumeResult {
  const row = deps.store.get(recapId)
  if (!row) throw new Error(`recap ${recapId} not found`)
  if (!deps.bundle) throw new Error('run-artifact bundles are not enabled on this broker')
  const manifest = deps.bundle.readManifest(recapId)
  if (!manifest) {
    throw new Error(`recap ${recapId} has no run-artifact bundle (predates Pillar C+); create a fresh recap`)
  }
  if (manifest.mode !== 'chunked') {
    throw new Error(
      `recap ${recapId} is mode=${manifest.mode ?? 'unknown'}; resume-from-map only applies to chunked recaps`,
    )
  }
  if (isRecapInFlight(row.status)) {
    throw new Error(`recap ${recapId} is still ${row.status} -- nothing to resume`)
  }
  const priorResumes = manifest.resumeCount ?? 0
  if (priorResumes >= MAX_RESUME_ATTEMPTS) {
    const reason = `resume cap reached (${MAX_RESUME_ATTEMPTS} attempts) -- not retrying`
    const failedAt = Date.now()
    deps.store.update(recapId, { status: 'failed', error: reason, completedAt: failedAt })
    deps.bundle.updateManifest(recapId, { status: 'failed', error: reason, completedAt: failedAt })
    throw new Error(`recap ${recapId}: ${reason}`)
  }

  const totalChunks = manifest.chunkCount ?? 0
  let reusableChunks = 0
  for (let i = 0; i < totalChunks; i++) {
    if (deps.bundle.readMapParsed(recapId, i) != null) reusableChunks++
  }

  // Reconstruct run inputs from the row + manifest so the re-split is IDENTICAL
  // (same chunkSize -> same boundaries -> persisted map-N aligns with chunk N).
  const recipe = (jsonParseOr(row.argsJson) ?? {}) as Record<string, unknown>
  const period: ResolvedPeriod = {
    label: manifest.period.label,
    start: row.periodStart,
    end: row.periodEnd,
    human: manifest.period.human ?? '',
    isoRange: manifest.period.isoRange ?? '',
  }
  const tuning: RecapTuning = {
    forceMode: 'chunked',
    ...(typeof recipe.chunkSize === 'number' ? { chunkSize: recipe.chunkSize } : {}),
    ...(typeof recipe.thresholdChars === 'number' ? { thresholdChars: recipe.thresholdChars } : {}),
    ...(typeof recipe.thresholdConvs === 'number' ? { thresholdConvs: recipe.thresholdConvs } : {}),
    ...(manifest.models?.map ? { mapModel: manifest.models.map } : {}),
    ...(manifest.models?.reduce ? { reduceModel: manifest.models.reduce } : {}),
  }
  const args: StartArgs = {
    type: 'recap_create',
    projectUri: row.projectUri,
    period: {
      label: row.periodLabel as RecapCreateMessage['period']['label'],
      start: row.periodStart,
      end: row.periodEnd,
    },
    timeZone: row.timeZone,
    audience: row.audience,
    ...(((jsonParseOr(row.signalsJson) as RecapSignal[] | undefined) ?? undefined) && {
      signals: jsonParseOr(row.signalsJson) as RecapSignal[],
    }),
    // Restore the presentation recipe from args_json so a resumed run renders the
    // SAME template + option toggles it was created with (it would otherwise fall
    // back to the default template + signals are re-derived). Defensive reads.
    ...(typeof recipe.template === 'string' ? { template: recipe.template } : {}),
    ...(recipe.options && typeof recipe.options === 'object'
      ? { options: recipe.options as Record<string, boolean> }
      : {}),
    // Product modes live in the bundle manifest, not args_json (which is the
    // tuning recipe). Restore them so a resumed run keeps its retrospect layer
    // and its customer-friendly tone -- both were Opus-only and would otherwise
    // be silently dropped on resume.
    ...(manifest.retrospect ? { retrospect: true } : {}),
    ...(manifest.customerFriendly ? { customerFriendly: true } : {}),
    ...(manifest.instructions ? { instructions: manifest.instructions } : {}),
    tuning,
    force: true,
    ...(row.informConversationId ? { informConversationId: row.informConversationId } : {}),
  }

  const resumeCount = priorResumes + 1
  deps.bundle.updateManifest(recapId, { status: 'rendering', resumeCount })
  deps.store.update(recapId, { status: 'rendering', progress: 0, error: null })
  scheduleRun(
    deps,
    recapId,
    args,
    period,
    row.timeZone,
    i => deps.bundle?.readMapParsed<RecapMetadata>(recapId, i) ?? null,
  )

  return { recapId, resumeCount, reusableChunks, totalChunks }
}

function jsonParseOr(raw: string | null | undefined): unknown {
  if (!raw) return undefined
  try {
    return JSON.parse(raw)
  } catch {
    return undefined
  }
}

// fallow-ignore-next-line complexity
async function runRegenerate(
  deps: OrchestratorDeps,
  targetId: string,
  src: ReturnType<PeriodRecapStore['get']> & object,
  manifest: NonNullable<ReturnType<RecapBundleWriter['readManifest']>>,
  args: RegenerateArgs,
  ledger: RecapLedger,
): Promise<void> {
  const startedAt = Date.now()
  const audience: RecapAudience = src.audience
  const emit = createProgressEmitter({
    recapId: targetId,
    store: deps.store,
    broadcaster: deps.broadcaster,
    bundle: deps.bundle,
  })
  emit.setStatus('rendering')
  emit.emit(
    'info',
    'regenerate/begin',
    `regenerate from='${args.from}' mode='${args.mode ?? 'fork'}' (source ${src.id})`,
  )
  deps.store.update(targetId, { startedAt })

  // Re-gather COST 1 inputs (cost table + digest). Local SQLite, no model call --
  // the expensive map/synthesis is what the bundle lets us skip, not the gather.
  const projectUris = resolveProjectScope(deps.brokerStore, src.projectUri, deps.expandProjectScope)
  const scope: PeriodScope = {
    projectUris,
    periodStart: src.periodStart,
    periodEnd: src.periodEnd,
    timeZone: src.timeZone,
  }
  const period: ResolvedPeriod = {
    label: manifest.period.label,
    start: manifest.period.start,
    end: manifest.period.end,
    human: manifest.period.human ?? '',
    isoRange: manifest.period.isoRange ?? '',
  }
  const parsedSignals = JSON.parse(src.signalsJson || '[]')
  const includeInternals = parsedSignals.includes('turn_internals')
  const includeStatus = parsedSignals.includes('agent_status')
  const includeContention = parsedSignals.includes('contention')
  const { promptInputs } = collectSignals(
    deps,
    scope,
    period,
    src.projectUri,
    deps.projectLabel,
    includeInternals,
    includeStatus,
    includeContention,
  )
  if (deps.gatherCommits) {
    try {
      promptInputs.commits = await deps.gatherCommits(scope)
    } catch (err) {
      emit.emit('warn', 'regenerate/commits', `git gather failed: ${describe(err)}`)
    }
  }

  // Produce the parsed recap from the requested stage.
  const { parsed, model } = await replayStage(deps, targetId, ledger, emit, args, manifest, promptInputs, audience)

  const finalMarkdown = renderFinalMarkdown({
    title: src.title ?? `${promptInputs.projectLabel} - ${period.human}`,
    subtitle: parsed.metadata.subtitle,
    projectLabel: promptInputs.projectLabel,
    projectUri: src.projectUri,
    periodHuman: period.human,
    periodIsoRange: period.isoRange,
    generatedAt: Date.now(),
    model,
    recapId: targetId,
    audience,
    cost: promptInputs.cost,
    body: parsed.body,
  })
  deps.bundle?.recordFinalMarkdown(targetId, finalMarkdown)

  const digest = buildRecapDigest({
    cost: promptInputs.cost,
    conversations: promptInputs.conversations,
    commits: promptInputs.commits,
    tools: promptInputs.tools,
    errors: promptInputs.errors,
  })

  finalize(deps, targetId, ledger, {
    title: src.title ?? `${promptInputs.projectLabel} - ${period.human}`,
    subtitle: parsed.metadata.subtitle,
    markdown: finalMarkdown,
    metadata: parsed.metadata,
    digestJson: JSON.stringify(digest),
    body: parsed.body,
    projectUri: src.projectUri,
  })
  emit.setProgress(100, 'persist')
  emit.setStatus('done')
  emit.emit('info', 'persist', `regenerated recap stored as ${targetId}`)
  deps.broadcaster.broadcast({
    type: 'recap_complete',
    recapId: targetId,
    title: src.title ?? '',
    markdown: finalMarkdown,
    meta: rowToMeta(deps, targetId),
  })
}

/** Effective refinement overrides for a regenerate: instructions (undefined =
 *  reuse source) + the resolved sampling knobs. */
interface RefineOverrides {
  effInstructions?: string
  instructionsProvided: boolean
  temperature: number
  maxTokens: number
}

/** synthesize from the chunked merged JSON: rebuild the reduce prompt (honoring
 *  the instruction override) and make the single reduce call. */
async function synthesizeFromMerged(
  deps: OrchestratorDeps,
  targetId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  args: RegenerateArgs,
  manifest: NonNullable<ReturnType<RecapBundleWriter['readManifest']>>,
  promptInputs: PromptInputs,
  audience: RecapAudience,
  merged: RecapMetadata,
  ov: RefineOverrides,
): Promise<{ parsed: ParsedRecap; model: string }> {
  const model = args.model ?? manifest.models?.reduce ?? 'anthropic/claude-opus-4.8'
  emit.setProgress(55, 'regenerate/synthesize')
  const synth = buildSynthesizePrompt(
    merged,
    {
      projectLabel: promptInputs.projectLabel,
      periodHuman: promptInputs.periodHuman,
      periodIsoRange: promptInputs.periodIsoRange,
      forgotten: promptInputs.forgotten,
      agentStatus: promptInputs.conversations,
      contention: promptInputs.contention,
    },
    audience,
    manifest.retrospect ?? false,
    manifest.customerFriendly ?? false,
    undefined,
    ov.effInstructions,
  )
  const content = await runLlmCall(deps, targetId, ledger, 'reduce', {
    feature: 'recap-period',
    model,
    system: synth.system,
    user: synth.user,
    maxTokens: ov.maxTokens,
    timeoutMs: RECAP_SYNTHESIS_TIMEOUT_MS,
    temperature: ov.temperature,
    retries: 2,
    apiKey: deps.apiKey,
  })
  deps.bundle?.recordFinalResponse(targetId, content)
  const parsed = await parseOrRetry(deps, targetId, ledger, content, synth, model, deps.apiKey)
  return { parsed, model }
}

/** oneshot bundle: replay the saved oneshot prompt. When the caller re-steers the
 *  instructions, swap the trailing directives block in place -- the saved prompt
 *  already carries the extraction, so this re-shapes prose without the $$ map
 *  re-run. A pure model/temperature swap replays verbatim. */
async function replayOneshot(
  deps: OrchestratorDeps,
  targetId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  args: RegenerateArgs,
  manifest: NonNullable<ReturnType<RecapBundleWriter['readManifest']>>,
  sourceId: string,
  ov: RefineOverrides,
): Promise<{ parsed: ParsedRecap; model: string }> {
  const prompt = deps.bundle?.readStagePrompt(sourceId, 'oneshot')
  if (!prompt?.system || !prompt.user) throw new Error('no merged JSON or oneshot prompt available to synthesize')
  const model = args.model ?? manifest.models?.oneshot ?? 'anthropic/claude-opus-4.8'
  emit.setProgress(55, 'regenerate/synthesize')
  const system = ov.instructionsProvided ? swapInstructions(prompt.system, ov.effInstructions) : prompt.system
  const built = { system, user: prompt.user }
  const content = await callLlm(deps, targetId, ledger, built, model, deps.apiKey, {
    temperature: ov.temperature,
    maxTokens: ov.maxTokens,
  })
  deps.bundle?.recordFinalResponse(targetId, content)
  const parsed = await parseOrRetry(deps, targetId, ledger, content, built, model, deps.apiKey)
  return { parsed, model }
}

/** Re-produce the parsed recap for the requested resume stage. render/html never
 *  call a model; synthesize makes exactly one LLM call on saved upstream input. */
async function replayStage(
  deps: OrchestratorDeps,
  targetId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  args: RegenerateArgs,
  manifest: NonNullable<ReturnType<RecapBundleWriter['readManifest']>>,
  promptInputs: PromptInputs,
  audience: RecapAudience,
): Promise<{ parsed: ParsedRecap; model: string }> {
  const sourceId = args.recapId
  if (args.from === 'render' || args.from === 'html') {
    emit.setProgress(60, 'regenerate/render')
    const content = deps.bundle?.readFinalResponse(sourceId)
    if (!content) throw new Error('saved final response vanished')
    const parsed = parseRecapOutput(content)
    return { parsed, model: manifest.models?.reduce ?? manifest.models?.oneshot ?? 'saved' }
  }
  // Effective refinement overrides: instructions default to the source's own
  // (manifest) unless the caller passed a value; sampling only overrides when set.
  const instructionsProvided = args.instructions !== undefined
  const ov: RefineOverrides = {
    effInstructions: instructionsProvided ? args.instructions?.trim() || undefined : manifest.instructions,
    instructionsProvided,
    temperature: args.temperature ?? 0.2,
    maxTokens: args.maxTokens ?? RECAP_MAX_TOKENS,
  }
  // synthesize: prefer the chunked merged JSON; fall back to replaying oneshot.
  const merged = deps.bundle?.readMerged<RecapMetadata>(sourceId)
  return merged
    ? synthesizeFromMerged(deps, targetId, ledger, emit, args, manifest, promptInputs, audience, merged, ov)
    : replayOneshot(deps, targetId, ledger, emit, args, manifest, sourceId, ov)
}

// fallow-ignore-next-line complexity
async function runRecap(
  deps: OrchestratorDeps,
  recapId: string,
  args: StartArgs,
  period: ResolvedPeriod,
  timeZone: string,
  ledger: RecapLedger,
  /** Resume-from-map: reuse persisted chunk extractions instead of re-paying. */
  reuseMap?: (index: number) => RecapMetadata | null,
): Promise<void> {
  const startedAt = Date.now()
  // Re-derive the SAME recipe startRecap resolved (deterministic from args): the
  // template owns audience, drives the signal set, and feeds the prompt builders.
  const recipe = resolveRecipe(args)
  const audience: RecapAudience = recipe.audience
  // Pillar C+: open the on-disk bundle BEFORE the first progress line so the
  // partial trail captures the whole run (incl. an early gather crash).
  deps.bundle?.begin(recapId, {
    projectUri: args.projectUri,
    period: {
      label: args.period.label,
      start: period.start,
      end: period.end,
      human: period.human,
      isoRange: period.isoRange,
    },
    audience,
    ...(args.retrospect ? { retrospect: true } : {}),
    ...(args.customerFriendly ? { customerFriendly: true } : {}),
    ...(args.instructions?.trim() ? { instructions: args.instructions.trim() } : {}),
    ...(args.batchId ? { batchId: args.batchId } : {}),
    createdAt: startedAt,
    ...(args.createdBy ? { createdBy: args.createdBy } : {}),
  })

  const emit = createProgressEmitter({ recapId, store: deps.store, broadcaster: deps.broadcaster, bundle: deps.bundle })
  emit.setStatus('gathering')
  emit.setProgress(2, 'gather/begin')
  deps.store.update(recapId, { startedAt })
  deps.bundle?.updateManifest(recapId, { startedAt })
  console.log(`[recap] ${recapId} start: project=${args.projectUri} period=${args.period.label} audience=${audience}`)

  const projectUris = resolveProjectScope(deps.brokerStore, args.projectUri, deps.expandProjectScope)
  const scope: PeriodScope = { projectUris, periodStart: period.start, periodEnd: period.end, timeZone }

  const includeInternals = recipe.signals.includes('turn_internals')
  const includeStatus = recipe.signals.includes('agent_status')
  const includeContention = recipe.signals.includes('contention')
  const { promptInputs, inputChars } = collectSignals(
    deps,
    scope,
    period,
    args.projectUri,
    deps.projectLabel,
    includeInternals,
    includeStatus,
    includeContention,
  )
  // Real git gather (async, via sentinel RPC) replaces the empty stub when the
  // broker injected a gatherer. Failures degrade to the stub commits already in
  // promptInputs -- a recap without git data still renders.
  if (deps.gatherCommits) {
    try {
      promptInputs.commits = await deps.gatherCommits(scope)
      const n = promptInputs.commits.perProject.reduce((s, p) => s + p.commits.length, 0)
      emit.emit(
        'info',
        'gather/commits',
        `git gather: ${n} commit(s) across ${promptInputs.commits.perProject.length} project(s)`,
      )
    } catch (err) {
      emit.emit('warn', 'gather/commits', `git gather failed: ${describe(err)}`)
    }
  }

  emit.emit(
    'info',
    'gather/done',
    `gathered ${promptInputs.conversations.length} conversations, ${inputChars} chars input (audience=${audience})`,
  )
  // Forgotten threads: no silent caps -- log the full funnel (candidate pool ->
  // tails probed -> open-loop survivors shown) so a missing thread is explainable.
  const fg = promptInputs.forgotten
  emit.emit(
    'info',
    'gather/forgotten',
    `forgotten threads: ${fg.threads.length} shown (open-loop survivors) of ${fg.candidateCount} stale+invested candidate(s), ${fg.probed} tail(s) probed`,
  )
  // Contention: no-silent-caps funnel -- what was scanned vs surfaced. Only present
  // when the `contention` signal is on (the agentic-retrospect template).
  const ct = promptInputs.contention
  if (ct) {
    emit.emit(
      'info',
      'gather/contention',
      `contention: ${ct.fileCollisions.length} file collision(s), ${ct.mainTreeEdits.length} main-tree edit(s), ` +
        `${ct.fanout.length} fan-out cluster(s) from ${ct.scanned.editEvents} edit event(s) across ` +
        `${ct.scanned.conversationsWithEdits} conversation(s) (${ct.scanned.filesTouched} file(s) touched, ` +
        `${ct.scanned.collisionCandidates} collision candidate(s) before cap)`,
    )
  }
  emit.setProgress(35, 'gather/done')

  const built = buildPrompt(
    promptInputs,
    audience,
    args.retrospect ?? false,
    args.customerFriendly ?? false,
    presentationOf(recipe),
    args.instructions,
  )
  emit.setStatus('rendering')
  // ONESHOT for small periods (one Opus pass), CHUNKED map-reduce for big ones
  // (parallel cheap extraction -> code merge -> one Opus synthesis). Both feed
  // the SAME parseRecapOutput/finalize downstream. The WHOLE render races the
  // overall deadline (deadline.ts) -- the master cap scaled by conversation count
  // -- so a hung map OR reduce call force-fails the run instead of hanging the
  // progress bar. Banked map/merge output survives on disk for a cost-safe resume.
  const convCount = promptInputs.conversations.length
  const overallMs = overallDeadlineMs(convCount)
  const remainingMs = overallMs - (Date.now() - startedAt)
  console.log(
    `[recap] ${recapId} render start: ${convCount} conv(s), ${inputChars} chars, ` +
      `overall deadline ${Math.round(overallMs / 1000)}s (${Math.round(remainingMs / 1000)}s left after gather)`,
  )
  const { parsed, model, partial } = await withDeadline(remainingMs, convCount, () =>
    produceRecap(deps, recapId, ledger, emit, {
      built,
      promptInputs,
      audience,
      args,
      recipe,
      reuseMap,
    }),
  )
  const partialReason = partial
    ? `${partial.failed} of ${partial.total} chunk(s) failed -- recap is partial`
    : undefined
  const baseTitle = `${promptInputs.projectLabel} - ${period.human}`
  const titleTemplate = args.tuning?.variantLabel ? `${baseTitle} [${args.tuning.variantLabel}]` : baseTitle
  const finalMarkdown = renderFinalMarkdown({
    title: titleTemplate,
    subtitle: parsed.metadata.subtitle,
    projectLabel: promptInputs.projectLabel,
    projectUri: args.projectUri,
    periodHuman: period.human,
    periodIsoRange: period.isoRange,
    generatedAt: Date.now(),
    model,
    recapId,
    audience,
    cost: promptInputs.cost,
    body: parsed.body,
    partialNote: partialReason,
  })
  deps.bundle?.recordFinalMarkdown(recapId, finalMarkdown)

  const digest = buildRecapDigest({
    cost: promptInputs.cost,
    conversations: promptInputs.conversations,
    commits: promptInputs.commits,
    tools: promptInputs.tools,
    errors: promptInputs.errors,
  })

  finalize(deps, recapId, ledger, {
    title: titleTemplate,
    subtitle: parsed.metadata.subtitle,
    markdown: finalMarkdown,
    metadata: parsed.metadata,
    digestJson: JSON.stringify(digest),
    body: parsed.body,
    projectUri: args.projectUri,
    status: partial ? 'partial' : 'done',
    partialReason,
  })
  emit.setProgress(100, 'persist')
  emit.setStatus(partial ? 'partial' : 'done')
  emit.emit(
    'info',
    'persist',
    partial ? `recap stored as ${recapId} (PARTIAL: ${partialReason})` : `recap stored as ${recapId}`,
  )
  console.log(
    `[recap] ${recapId} ${partial ? 'PARTIAL' : 'done'} in ${Math.round((Date.now() - startedAt) / 1000)}s` +
      ` ($${ledger.build().summary.totalCostUsd.toFixed(4)}, model=${model})`,
  )
  deps.broadcaster.broadcast({
    type: 'recap_complete',
    recapId,
    title: titleTemplate,
    markdown: finalMarkdown,
    meta: rowToMeta(deps, recapId),
  })

  // inform_on_complete: push a recap-completed channel message into the
  // requesting conversation instead of making it poll recap_get.
  if (args.informConversationId && deps.informConversation) {
    deps.informConversation(args.informConversationId, {
      recapId,
      text: buildInformText({
        recapId,
        audience,
        projectLabel: promptInputs.projectLabel,
        periodHuman: period.human,
        conversationCount: promptInputs.conversations.length,
        body: parsed.body,
        partialReason,
      }),
    })
  }
}

function collectSignals(
  deps: OrchestratorDeps,
  scope: PeriodScope,
  period: ResolvedPeriod,
  projectUri: string,
  projectLabelFn: ((uri: string) => string) | undefined,
  includeInternals: boolean,
  includeStatus: boolean,
  includeContention: boolean,
): { promptInputs: PromptInputs; inputChars: number } {
  const conversations = gatherConversations(deps.brokerStore, scope, includeStatus)
  const transcripts = gatherTranscripts(deps.brokerStore, conversations, scope, includeInternals)
  const cost = gatherCost(deps.brokerStore, scope)
  const tasks = gatherTasks(deps.brokerStore, conversations, scope)
  const tools = gatherToolUse(deps.brokerStore, conversations, scope)
  const errors = gatherErrors(deps.brokerStore, conversations, scope)
  const openQuestions = gatherOpenQuestions(deps.brokerStore, conversations, scope)
  const forgotten = gatherForgotten(deps.brokerStore, scope)
  const commits = gatherCommitsStub(scope)
  const promptInputs: PromptInputs = {
    projectLabel: (projectLabelFn ?? defaultLabel)(projectUri),
    periodHuman: period.human,
    periodIsoRange: period.isoRange,
    conversations,
    transcripts,
    cost,
    tasks,
    tools,
    errors,
    openQuestions,
    forgotten,
    commits,
    // Gated: only the agentic-retrospect template (contention signal) pays for the mining.
    ...(includeContention ? { contention: gatherContention(deps.brokerStore, conversations, scope) } : {}),
  }
  const inputChars = transcripts.reduce(
    (sum, t) => sum + t.turns.reduce((s, tr) => s + tr.userPrompt.length + tr.assistantFinal.length, 0),
    0,
  )
  return { promptInputs, inputChars }
}

// A full human recap is a large YAML frontmatter (every features/bugs/fixes/
// decisions/dead_ends/gotchas item) PLUS the markdown body. The old 8k cap
// truncated big multi-day recaps mid-frontmatter -- the closing `---` and body
// never arrived, so parseRecapOutput threw "missing YAML frontmatter block".
// 32k is Opus 4.8's max output; it leaves comfortable headroom. Pair it with a
// generous timeout: a 32k-token generation easily exceeds the client's 30s
// default. Recaps run async (background), so the higher ceiling costs no UX.
const RECAP_MAX_TOKENS = 32_000
/** Per-map-call timeout, env-overridable (ops tuning + test seam). The map path
 *  is the one that froze for ~12min (a 707s Bedrock call the old 240s timeout
 *  never aborted -- see plan-recap-resilience B1), hence the tight bound. */
function mapCallTimeoutMs(): number {
  const override = Number(process.env.CLAUDWERK_RECAP_MAP_TIMEOUT_MS)
  return Number.isFinite(override) && override > 0 ? override : RECAP_MAP_TIMEOUT_MS
}
// A map extraction that came back this large almost certainly hit the output
// token cap (finish_reason=length) and is truncated mid-JSON -- a normal map
// output is well under 20k chars. Used only to LABEL the failure actionably;
// the authoritative finish_reason is in the bundle's raw response.
const TRUNCATION_HINT_CHARS = 50_000

// Usage recorded when a chat() call THROWS (timeout/4xx/5xx): the attempt
// happened but carries no token/cost data. costSource 'unknown' marks it.
const ZERO_USAGE: NormalizedUsage = {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
  costSource: 'unknown',
}

/**
 * Single LLM-call primitive for the whole pipeline (oneshot/map/reduce/retry).
 * Times the call, records a ledger entry on BOTH success and failure (COST 2 --
 * a failed recap still shows the tokens it burned, unlike the old aggregate),
 * and flushes the ledger to the row incrementally so a crash mid-run leaves the
 * partial cost trail. Re-throws on error after recording. Returns the content.
 */
async function runLlmCall(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  stage: RecapLedgerStage,
  req: ChatRequest,
  chunkIndex?: number,
): Promise<string> {
  const t0 = Date.now()
  const idx = chunkIndex !== undefined ? { chunkIndex } : {}
  // Pillar C+: capture the assembled prompt (secret-free by construction --
  // bundlePrompt has no apiKey field) BEFORE the call, so a crash mid-call still
  // leaves the prompt on disk. Pair the response/error by the returned seq.
  const bundlePrompt = toBundlePrompt(stage, req, chunkIndex)
  const seq = deps.bundle?.recordCallPrompt(recapId, bundlePrompt)
  try {
    const res = await chat(req)
    ledger.addCall({ stage, model: req.model, usage: res.usage, ms: Date.now() - t0, ...idx })
    flushLedger(deps, recapId, ledger)
    if (seq !== undefined) {
      deps.bundle?.recordCallResponse(recapId, seq, bundlePrompt, {
        ok: true,
        ms: Date.now() - t0,
        content: res.content,
        raw: res.raw,
      })
    }
    return res.content
  } catch (err) {
    ledger.addCall({
      stage,
      model: req.model,
      usage: ZERO_USAGE,
      ms: Date.now() - t0,
      ok: false,
      error: describe(err),
      ...idx,
    })
    flushLedger(deps, recapId, ledger)
    if (seq !== undefined) {
      deps.bundle?.recordCallResponse(recapId, seq, bundlePrompt, {
        ok: false,
        ms: Date.now() - t0,
        error: describe(err),
      })
    }
    throw err
  }
}

/** Project a ChatRequest to the bundle's secret-free prompt shape. NOTE: the
 *  apiKey/fetcher fields are deliberately NOT copied -- the bundle must never see
 *  a credential (the bearer key only ever lives in the HTTP header). */
function toBundlePrompt(stage: RecapLedgerStage, req: ChatRequest, chunkIndex?: number): RecapBundleCallPrompt {
  return {
    stage,
    ...(chunkIndex !== undefined ? { chunkIndex } : {}),
    model: req.model,
    params: {
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxTokens !== undefined ? { maxTokens: req.maxTokens } : {}),
      ...(req.responseFormat !== undefined ? { responseFormat: req.responseFormat } : {}),
      ...(req.retries !== undefined ? { retries: req.retries } : {}),
    },
    ...(req.system !== undefined ? { system: req.system } : {}),
    ...(req.user !== undefined ? { user: req.user } : {}),
    ...(req.messages !== undefined ? { messages: req.messages } : {}),
  }
}

/** Persist the ledger snapshot to ledger_json. Cheap (small JSON); called after
 *  every LLM call for incremental durability. */
function flushLedger(deps: OrchestratorDeps, recapId: string, ledger: RecapLedger): void {
  deps.store.update(recapId, { ledgerJson: JSON.stringify(ledger.build()) })
}

async function callLlm(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  prompt: { system: string; user: string },
  model: string,
  apiKey?: string,
  opts?: { temperature?: number; maxTokens?: number },
): Promise<string> {
  return runLlmCall(deps, recapId, ledger, 'oneshot', {
    feature: 'recap-period',
    model,
    system: prompt.system,
    user: prompt.user,
    maxTokens: opts?.maxTokens ?? RECAP_MAX_TOKENS,
    timeoutMs: RECAP_SYNTHESIS_TIMEOUT_MS,
    timeoutRetries: RECAP_TIMEOUT_RETRIES,
    temperature: opts?.temperature ?? 0.2,
    retries: 2,
    apiKey,
  })
}

async function parseOrRetry(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  content: string,
  built: { system: string; user: string },
  model: string,
  apiKey?: string,
) {
  try {
    return parseRecapOutput(content)
  } catch (err) {
    if (!(err instanceof RecapParseError)) throw err
    const retry = await runLlmCall(deps, recapId, ledger, 'retry', {
      feature: 'recap-period',
      model,
      apiKey,
      retries: 1,
      maxTokens: RECAP_MAX_TOKENS,
      timeoutMs: RECAP_SYNTHESIS_TIMEOUT_MS,
      timeoutRetries: RECAP_TIMEOUT_RETRIES,
      temperature: 0.1,
      messages: [
        { role: 'system', content: built.system },
        { role: 'user', content: built.user },
        { role: 'assistant', content },
        {
          role: 'user',
          content:
            'Your previous response was malformed (missing or invalid YAML frontmatter). Re-emit ONLY the YAML frontmatter block (between --- lines) followed by the markdown body, in the exact format specified. No prose before the opening --- and no prose after the closing body.',
        },
      ],
    })
    return parseRecapOutput(retry)
  }
}

// Bounded parallelism for the map stage: a month-long recap can produce dozens
// of chunks; firing them all at once would hammer OpenRouter + risk 429s.
const MAP_CONCURRENCY = Number(process.env.CLAUDWERK_RECAP_MAP_CONCURRENCY) || 4

// Overall map-stage deadline. Per-call timeouts (Phase 1) bound a SINGLE call,
// but with bounded concurrency a big all-slow recap is still sum-of-waves; this
// caps the TOTAL so one pathological run can't hold the barrier for ~an hour.
// Scales with chunk count (a proxy for conversation count -- chunks are char-
// bounded), per Jonas's "deadline should scale with conversations" note. Floor
// is the dialog's 10min; ceil keeps even a huge month-recap bounded.
const MAP_STAGE_FLOOR_MS = 10 * 60_000
// The overall conv-scaled deadline (deadline.ts, <=30min) is now the master cap
// for the whole render, so the map stage no longer needs its own hour-scale ceil
// (dropped the old 45min): it always sits under the overall race regardless.
const MAP_STAGE_CEIL_MS = 20 * 60_000
export function mapStageDeadlineMs(chunkCount: number): number {
  // Test/ops override -- a tiny value lets tests exercise the degrade path.
  const override = Number(process.env.CLAUDWERK_RECAP_MAP_STAGE_DEADLINE_MS)
  if (Number.isFinite(override) && override > 0) return override
  const waves = Math.max(1, Math.ceil(chunkCount / MAP_CONCURRENCY))
  const perWaveMs = RECAP_MAP_TIMEOUT_MS * (RECAP_TIMEOUT_RETRIES + 1)
  const raw = Math.ceil(waves * perWaveMs * 1.2)
  return Math.min(MAP_STAGE_CEIL_MS, Math.max(MAP_STAGE_FLOOR_MS, raw))
}

export interface MapStageResult {
  metas: RecapMetadata[]
  /** Chunks that errored/timed-out/tripped the deadline (drive 'partial'). */
  failed: number
  /** Chunks skipped by the G8 empty-input gate (NOT failures). */
  skippedEmpty: number
  /** Chunks reused from the bundle on a resume (NOT re-mapped, NOT failures). */
  reused: number
  /** True if the overall stage deadline fired. */
  stageTimedOut: boolean
}

/**
 * MAP stage: parallel extraction with a per-call timeout (Phase 1) AND an overall
 * stage deadline (a backstop so one pathological run can't hold the barrier). A
 * chunk that errors/times-out/trips the deadline degrades to empty metadata and
 * counts as `failed`; an EMPTY chunk (G8) is skipped without a call and is NOT a
 * failure. Extracted from runChunked for testability + lower complexity.
 */
// fallow-ignore-next-line complexity
export async function runMapStage(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  chunks: ReturnType<typeof splitIntoChunks>,
  mapModel: string,
  t: RecapTuning,
  reuseMap?: (index: number) => RecapMetadata | null,
): Promise<MapStageResult> {
  const stageDeadlineMs = mapStageDeadlineMs(chunks.length)
  const state = { failed: 0, skippedEmpty: 0, reused: 0, stageTimedOut: false }
  let stageTimer: ReturnType<typeof setTimeout> | undefined
  const stageDeadline = new Promise<never>((_, reject) => {
    stageTimer = setTimeout(() => {
      state.stageTimedOut = true
      reject(new Error(`map stage deadline exceeded (${Math.round(stageDeadlineMs / 1000)}s)`))
    }, stageDeadlineMs)
  })
  stageDeadline.catch(() => {}) // no unhandled rejection once the stage is past it

  const metas = await parallelMap(chunks, MAP_CONCURRENCY, async chunk => {
    const phase = `render/map ${chunk.index + 1}/${chunks.length}`
    // Resume-from-map: a chunk already extracted on a prior run is reused from
    // the bundle -- no LLM call, no cost. NOT a failure, NOT empty.
    const reused = reuseMap?.(chunk.index) ?? null
    if (reused) {
      emit.emit('info', phase, `chunk ${chunk.index + 1} reused from bundle (resume -- not re-mapped)`)
      state.reused++
      return reused
    }
    // G8 empty-input gate: nothing to send -> skip the call. An empty/whitespace
    // prompt wastes spend and can hang a provider; a content-free chunk is just
    // "done, no evidence" (Jonas's instinct -- defensive, not this incident's bug).
    if (chunk.chars <= 0 || chunk.transcripts.length === 0) {
      emit.emit('info', phase, `chunk ${chunk.index + 1} has no content -- skipping map call (empty)`)
      state.skippedEmpty++
      return makeEmptyMetadata()
    }
    const prompt = buildMapPrompt(chunk)
    emit.emit(
      'info',
      phase,
      `mapping chunk ${chunk.index + 1}/${chunks.length} (${chunk.chars} chars, ${chunk.transcripts.length} conv)`,
    )
    let content: string
    try {
      content = await Promise.race([
        runLlmCall(
          deps,
          recapId,
          ledger,
          'map',
          {
            feature: 'recap-period',
            model: mapModel,
            system: prompt.system,
            user: prompt.user,
            responseFormat: { type: 'json_object' },
            maxTokens: t.maxTokens?.map ?? RECAP_MAX_TOKENS,
            timeoutMs: mapCallTimeoutMs(),
            timeoutRetries: RECAP_TIMEOUT_RETRIES,
            temperature: t.temperature?.map ?? 0.1,
            retries: 2,
            apiKey: deps.apiKey,
          },
          chunk.index,
        ),
        stageDeadline,
      ])
    } catch (err) {
      state.failed++
      const reason = state.stageTimedOut
        ? `map stage deadline (${Math.round(stageDeadlineMs / 1000)}s) hit`
        : describe(err)
      emit.emit('warn', phase, `chunk ${chunk.index + 1} map call failed: ${reason}`)
      return makeEmptyMetadata()
    }
    try {
      const parsedChunk = parseMapOutput(content)
      // Pillar C+: persist the per-chunk extraction so a resume can re-merge
      // without re-paying the (expensive) map stage.
      deps.bundle?.recordMapParsed(recapId, chunk.index, parsedChunk)
      return parsedChunk
    } catch (err) {
      if (!(err instanceof MapParseError)) throw err
      state.failed++
      // finish_reason=length truncates the JSON mid-structure -> unparseable. A
      // huge response is the tell. Label it so the fix is obvious (shrink
      // CLAUDWERK_RECAP_CHUNK_SIZE_CHARS) rather than a generic parse error.
      const detail =
        content.length > TRUNCATION_HINT_CHARS
          ? `map output truncated at the token cap (${content.length} chars) -- chunk too large, reduce chunk size`
          : `map JSON unparseable: ${describe(err)}`
      emit.emit('warn', phase, `chunk ${chunk.index + 1} ${detail}`)
      return makeEmptyMetadata()
    }
  })
  if (stageTimer) clearTimeout(stageTimer) // disarm before reduce so it can't fire late
  return { metas, ...state }
}

interface ProduceArgs {
  built: { system: string; user: string; inputChars: number }
  promptInputs: PromptInputs
  audience: RecapAudience
  args: StartArgs
  /** Resolved presentation recipe (template + option flags + signals). Threads
   *  the selected template into the synthesize prompt + the persisted args_json. */
  recipe: ResolvedRecipe
  /** Resume-from-map: return a chunk's already-parsed extraction (from the
   *  bundle) to reuse it instead of re-paying the map call. null -> re-map. */
  reuseMap?: (index: number) => RecapMetadata | null
}

interface ProduceResult {
  parsed: ParsedRecap
  model: string
  /** Present iff the chunked map stage DROPPED >=1 chunk (timeout / truncation /
   *  stage-deadline). Drives the 'partial' terminal status + banner. Skipped
   *  empty chunks (G8) do NOT count -- they carried no evidence to lose. */
  partial?: { failed: number; total: number }
}

/**
 * Produce the parsed recap from the assembled prompt, choosing ONESHOT (small
 * periods -- one Opus pass) or CHUNKED map-reduce (big periods). Both return the
 * same { parsed, model } shape and feed the same downstream finalize.
 */
async function produceRecap(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  p: ProduceArgs,
): Promise<ProduceResult> {
  const { built, promptInputs, audience } = p
  const t = p.args.tuning ?? {}
  deps.store.update(recapId, { inputChars: built.inputChars })
  const chunked = shouldChunk(built.inputChars, promptInputs.conversations.length, {
    thresholdChars: t.thresholdChars,
    thresholdConvs: t.thresholdConvs,
    forceMode: t.forceMode,
  })
  if (chunked) return runChunked(deps, recapId, ledger, emit, p)

  const model = t.oneshotModel || pickModel(built.inputChars, audience).model
  deps.store.update(recapId, { model })
  persistRecipe(deps, recapId, 'oneshot', model, t, p.recipe)
  emit.emit('info', 'render/prompt', `oneshot model=${model}, prompt=${built.inputChars} chars`)
  emit.setProgress(45, 'render/llm')
  const content = await callLlm(deps, recapId, ledger, built, model, deps.apiKey, {
    temperature: t.temperature?.oneshot,
    maxTokens: t.maxTokens?.oneshot,
  })
  emit.setProgress(85, 'render/llm-done')
  deps.bundle?.recordFinalResponse(recapId, content)
  const parsed = await parseOrRetry(deps, recapId, ledger, content, built, model, deps.apiKey)
  return { parsed, model }
}

/**
 * CHUNKED map-reduce path (Pillar A). split -> parallel map (extraction JSON via
 * the cheap map model) -> code merge/dedup -> one Opus synthesis -> parseRecapOutput.
 * Every LLM call flows through runLlmCall, so each chunk + the reduce + any retry
 * lands its own COST-2 ledger entry (stage + chunkIndex), even on failure.
 */
// fallow-ignore-next-line complexity
async function runChunked(
  deps: OrchestratorDeps,
  recapId: string,
  ledger: RecapLedger,
  emit: ProgressEmitter,
  p: ProduceArgs,
): Promise<ProduceResult> {
  const { built, promptInputs, audience } = p
  const t = p.args.tuning ?? {}
  const models = chunkModels({ mapModel: t.mapModel, reduceModel: t.reduceModel })
  const chunks = splitIntoChunks(promptInputs.transcripts, t.chunkSize)
  deps.store.update(recapId, { model: models.reduceModel })
  persistRecipe(deps, recapId, 'chunked', models.reduceModel, t, p.recipe, {
    mapModel: models.mapModel,
    chunkCount: chunks.length,
  })
  emit.emit(
    'info',
    'render/chunk',
    `chunked map-reduce: ${chunks.length} chunk(s), map=${models.mapModel}, reduce=${models.reduceModel}, prompt=${built.inputChars} chars`,
  )
  emit.setProgress(45, 'render/map')

  // MAP -- parallel extraction with per-call timeout + overall stage deadline +
  // the G8 empty gate + resume-from-map reuse. Degrades dropped chunks rather
  // than hanging the barrier.
  const { metas, failed, skippedEmpty, reused, stageTimedOut } = await runMapStage(
    deps,
    recapId,
    ledger,
    emit,
    chunks,
    models.mapModel,
    t,
    p.reuseMap,
  )
  if (failed === chunks.length) {
    throw new Error(`chunked map stage failed: all ${chunks.length} chunk(s) errored`)
  }
  if (failed > 0) {
    emit.emit(
      'warn',
      'render/map-done',
      `${failed}/${chunks.length} chunk(s) failed${stageTimedOut ? ' (stage deadline hit)' : ''}; synthesizing from the rest`,
    )
  }
  if (skippedEmpty > 0) {
    emit.emit('info', 'render/map-done', `${skippedEmpty}/${chunks.length} chunk(s) skipped (empty -- no content)`)
  }
  if (reused > 0) {
    emit.emit(
      'info',
      'render/map-done',
      `${reused}/${chunks.length} chunk(s) reused from bundle (resume -- not re-paid)`,
    )
  }

  // MERGE -- pure deterministic dedup, no LLM.
  emit.setProgress(72, 'render/merge')
  const merged = mergeMetadata(metas)
  deps.bundle?.recordMerged(recapId, merged)
  emit.emit('info', 'render/merge', `merged ${chunks.length} chunk(s) -> ${countItems(merged)} item(s) after dedup`)

  // REDUCE -- one synthesis pass on the small merged JSON (not the raw bulk).
  // The merged JSON is banked (recordMerged above) BEFORE the call, so the
  // reduce is cheap to retry: `timeoutRetries: RECAP_TIMEOUT_RETRIES` (=1) below
  // AUTO-RETRIES the synthesize call once on a timeout against the SAME banked
  // merged JSON -- the expensive map extraction is never re-paid. If it still
  // fails, the banked merged JSON survives on disk for a one-click resume/Retry.
  emit.setProgress(78, 'render/synthesize')
  const synth = buildSynthesizePrompt(
    merged,
    {
      projectLabel: promptInputs.projectLabel,
      periodHuman: promptInputs.periodHuman,
      periodIsoRange: promptInputs.periodIsoRange,
      forgotten: promptInputs.forgotten,
      agentStatus: promptInputs.conversations,
      contention: promptInputs.contention,
    },
    audience,
    p.args.retrospect ?? false,
    p.args.customerFriendly ?? false,
    presentationOf(p.recipe),
    p.args.instructions,
  )
  const content = await runLlmCall(deps, recapId, ledger, 'reduce', {
    feature: 'recap-period',
    model: models.reduceModel,
    system: synth.system,
    user: synth.user,
    maxTokens: t.maxTokens?.reduce ?? RECAP_MAX_TOKENS,
    timeoutMs: RECAP_SYNTHESIS_TIMEOUT_MS,
    timeoutRetries: RECAP_TIMEOUT_RETRIES,
    temperature: t.temperature?.reduce ?? 0.2,
    retries: 2,
    apiKey: deps.apiKey,
  })
  emit.setProgress(88, 'render/synthesize-done')
  deps.bundle?.recordFinalResponse(recapId, content)
  const parsed = await parseOrRetry(deps, recapId, ledger, content, synth, models.reduceModel, deps.apiKey)
  return {
    parsed,
    model: models.reduceModel,
    ...(failed > 0 ? { partial: { failed, total: chunks.length } } : {}),
  }
}

/** Run `fn` over items with bounded concurrency, preserving input order. */
async function parallelMap<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const worker = async () => {
    while (true) {
      const i = next++
      if (i >= items.length) return
      results[i] = await fn(items[i])
    }
  }
  await Promise.all(Array.from({ length: workerCount }, worker))
  return results
}

function countItems(m: RecapMetadata): number {
  return (
    m.features.length +
    m.bugs.length +
    m.fixes.length +
    m.incidents.length +
    m.decisions.length +
    m.dead_ends.length +
    m.gotchas.length +
    m.frustrations.length
  )
}

/**
 * Pillar D: persist the RESOLVED recipe (actual models/thresholds/sizes used)
 * to the recap row's args_json, so every recap is self-describing and a
 * benevolent robot can compare variants by recipe + cost + grounding. Defaults
 * are baked in (not left implicit) so the stored recipe is reproducible.
 */
function persistRecipe(
  deps: OrchestratorDeps,
  recapId: string,
  mode: 'oneshot' | 'chunked',
  primaryModel: string,
  t: RecapTuning,
  resolved: ResolvedRecipe,
  extra?: Record<string, unknown>,
): void {
  const recipe: Record<string, unknown> = {
    mode,
    model: primaryModel,
    thresholdChars: t.thresholdChars ?? DEFAULT_CHUNK_THRESHOLD_CHARS,
    thresholdConvs: t.thresholdConvs ?? DEFAULT_CHUNK_THRESHOLD_CONVS,
    chunkSize: t.chunkSize ?? DEFAULT_CHUNK_SIZE_CHARS,
    ...(t.forceMode ? { forceMode: t.forceMode } : {}),
    ...(t.variantLabel ? { variantLabel: t.variantLabel } : {}),
    ...(t.temperature ? { temperature: t.temperature } : {}),
    ...(t.maxTokens ? { maxTokens: t.maxTokens } : {}),
    // The resolved presentation recipe (PLAN s7): template id + resolved option
    // flags + resolved signal set, persisted in the EXISTING args_json column so
    // every recap is self-describing (no new SQLite column, no migration).
    template: resolved.templateId,
    options: resolved.optionFlags,
    signals: resolved.signals,
    ...extra,
  }
  deps.store.update(recapId, { argsJson: JSON.stringify(recipe) })
  // Pillar C+: mirror the RESOLVED recipe + per-stage models into the manifest so
  // recap_regenerate (C++) knows the mode + models without re-deriving them.
  const mapModel = typeof extra?.mapModel === 'string' ? extra.mapModel : undefined
  const chunkCount = typeof extra?.chunkCount === 'number' ? extra.chunkCount : undefined
  const models =
    mode === 'chunked' ? { ...(mapModel ? { map: mapModel } : {}), reduce: primaryModel } : { oneshot: primaryModel }
  deps.bundle?.updateManifest(recapId, {
    mode,
    models,
    recipe,
    ...(chunkCount !== undefined ? { chunkCount } : {}),
  })
}

interface FinalizeArgs {
  title: string
  subtitle?: string
  markdown: string
  metadata: RecapMetadata
  digestJson: string
  body: string
  projectUri: string
  /** Terminal status for a completed document. 'done' = all input rendered;
   *  'partial' = the doc rendered but some map chunks were dropped (timeout /
   *  truncation / stage deadline). Defaults to 'done'. */
  status?: 'done' | 'partial'
  /** Human note for a partial recap (e.g. "2 of 6 chunks failed"). Stored in
   *  the `error` column so the existing UI surfaces it; null on a clean 'done'. */
  partialReason?: string
}

function finalize(deps: OrchestratorDeps, recapId: string, ledger: RecapLedger, args: FinalizeArgs): void {
  // Aggregate token/cost columns + the full ledger now derive from COST 2
  // (every call this run), so they include the retry call the old code dropped.
  const built = ledger.build()
  const completedAt = Date.now()
  const status = args.status ?? 'done'
  const partialReason = status === 'partial' ? (args.partialReason ?? 'some chunks were dropped') : null
  deps.store.update(recapId, {
    status,
    progress: 100,
    completedAt,
    title: args.title,
    subtitle: args.subtitle ?? null,
    markdown: args.markdown,
    metadataJson: JSON.stringify(args.metadata),
    digestJson: args.digestJson,
    error: partialReason,
    inputTokens: built.summary.totalInputTokens,
    outputTokens: built.summary.totalOutputTokens,
    llmCostUsd: built.summary.totalCostUsd,
    ledgerJson: JSON.stringify(built),
  })
  // Pillar C+: seal the bundle manifest with the final status + cost summary.
  deps.bundle?.updateManifest(recapId, { status, completedAt, cost: built.summary })
  const tags = denormalizeTags(recapId, args.metadata)
  deps.store.setTags(recapId, tags)
  deps.store.upsertFts(recapId, buildFtsFields(args.metadata, args.body, args.projectUri, args.title))
}

function rowToMeta(deps: OrchestratorDeps, recapId: string) {
  const row = deps.store.get(recapId)
  if (!row) throw new Error(`recap ${recapId} missing after finalize`)
  return rowToRecapMeta(row)
}

function defaultLabel(projectUri: string): string {
  if (projectUri === '*') return 'all projects'
  const match = projectUri.match(/[^/]+$/)
  return match ? match[0] : projectUri
}

/**
 * Cache key for a recap run. Two recaps sharing this key (within the 5-min
 * window) are the same document and dedupe. audience + customerFriendly + free-text
 * instructions + the presentation template + its resolved option toggles are all
 * part of the key: a human vs agent recap, a sanitized (customer-friendly) vs raw
 * recap, a recap shaped by a DIFFERENT instruction, a different template, OR a
 * different set of option booleans are DISTINCT documents even for the same
 * project+period+signals, so they must hash differently or one would serve the
 * other from cache. The instructions segment is APPENDED only when present, so a
 * recap with no instructions hashes byte-identically to before this field existed.
 */
export function recapCacheKey(args: {
  projectUri: string
  periodStart: number
  periodEnd: number
  audience: RecapAudience
  customerFriendly: boolean
  /** Free-text refinement directives; folded in (hashed) so a different directive
   *  is a distinct document. Trimmed; absent/empty adds nothing to the key. */
  instructions?: string
  signals: RecapSignal[]
  /** Resolved template id (after fallback). */
  template: string
  /** Resolved option flags (id -> boolean), serialized key-sorted for stability. */
  options: Record<string, boolean>
}): string {
  const optionsPart = Object.keys(args.options)
    .sort()
    .map(k => `${k}=${args.options[k] ? 1 : 0}`)
    .join(',')
  const parts = [
    args.projectUri,
    args.periodStart,
    args.periodEnd,
    args.audience,
    args.customerFriendly ? 'cf' : 'raw',
    args.signals.join(','),
    `tmpl:${args.template}`,
    `opts:${optionsPart}`,
  ]
  const instr = args.instructions?.trim()
  if (instr) parts.push(`instr:${sha256(instr)}`)
  return sha256(parts.join('|'))
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 32)
}

function nanoid(len: number): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let out = ''
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)]
  return out
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.message
  return String(err)
}

/**
 * Resolve the effective signal set. Explicit `args.signals` win verbatim (a hard
 * user override). Otherwise the base is the selected template's declared default
 * signals folded with its resolved option flags (a "technical" option adds/removes
 * a gather signal); when no template loaded, the base is DEFAULT_SIGNALS (the
 * untemplated default). The agent audience then opts `turn_internals` in (it backs
 * the "Dead ends" section) -- preserving the untemplated/default agent behaviour.
 * The anchor template's `defaults.signals` are byte-equal to DEFAULT_SIGNALS, so
 * the default path resolves an identical set (no cache-key drift).
 */
function resolveSignals(
  args: StartArgs,
  audience: RecapAudience,
  template?: RecapTemplate,
  optionFlags: Record<string, boolean> = {},
): RecapSignal[] {
  if (args.signals) return args.signals.slice().sort()
  const base = new Set<RecapSignal>(
    template ? (resolveTemplateSignals(template, optionFlags) as RecapSignal[]) : DEFAULT_SIGNALS,
  )
  if (audience === 'agent') base.add('turn_internals')
  return [...base].sort()
}

/** The fully resolved presentation recipe for a recap run. */
export interface ResolvedRecipe {
  /** Selected template (after fallback), or undefined if the templates dir is
   *  missing/broken -- the prompt builders then use their in-code fallback. */
  template?: RecapTemplate
  /** Resolved template id for the cache key + args_json. Falls back to the
   *  requested id (or the default) so the stored recipe is always self-describing. */
  templateId: string
  audience: RecapAudience
  /** Resolved option flags (id -> boolean): the `options.<id>` Liquid booleans. */
  optionFlags: Record<string, boolean>
  signals: RecapSignal[]
}

/**
 * Resolve a recap run's full presentation recipe ONCE: pick the requested template
 * (re-read per create -- the dir is tiny + read-mostly, PLAN s5), resolve its
 * option flags against the user overrides, derive the effective signal set, and
 * settle the audience. Deterministic from `args`, so startRecap (cache key +
 * signalsJson) and runRecap (prompt build + includeInternals) agree.
 */
export function resolveRecipe(args: StartArgs): ResolvedRecipe {
  // When no template is named, the default tracks the REQUESTED audience: an agent
  // recap (e.g. MCP recap_create's audience=agent default) resolves to agent-handoff,
  // a human recap to project-recap. An explicit args.template always wins. This keeps
  // the default agent brief rendering through the agent template (byte-identical to
  // the old in-code agent prompt) instead of the human anchor with the agent body.
  const requestedId = args.template ?? defaultTemplateIdFor(args.audience)
  const template = pickTemplate(loadTemplates().templates, requestedId)
  const audience = recipeAudience(args, template)
  const optionFlags = template ? resolveOptionFlags(template, args.options ?? {}) : {}
  const signals = resolveSignals(args, audience, template, optionFlags)
  return { template, templateId: recipeTemplateId(args, template), audience, optionFlags, signals }
}

/** The default template id for a requested audience: agent -> agent-handoff,
 *  human (or unspecified) -> project-recap. Used only when no template is named. */
function defaultTemplateIdFor(audience: RecapAudience | undefined): string {
  return audience === 'agent' ? AGENT_TEMPLATE_ID : DEFAULT_TEMPLATE_ID
}

/** The template OWNS audience (PLAN s4); an explicit caller audience still wins,
 *  and the anchor templates carry the matching audience so the untemplated default
 *  path is unchanged. Falls back to 'human' when no template loaded. */
function recipeAudience(args: StartArgs, template: RecapTemplate | undefined): RecapAudience {
  return args.audience ?? template?.audience ?? 'human'
}

/** Resolved template id for the cache key + args_json: the actually-rendered
 *  template, else the requested id, else the default -- always self-describing. */
function recipeTemplateId(args: StartArgs, template: RecapTemplate | undefined): string {
  return template?.id ?? args.template ?? DEFAULT_TEMPLATE_ID
}

/** Build the prompt-builder presentation selection from a resolved recipe. */
function presentationOf(recipe: ResolvedRecipe): PresentationSelection {
  return {
    ...(recipe.template ? { template: recipe.template } : {}),
    optionFlags: recipe.optionFlags,
  }
}

/** Build the recap-completed channel message text pushed to the caller. */
function buildInformText(args: {
  recapId: string
  audience: RecapAudience
  projectLabel: string
  periodHuman: string
  conversationCount: number
  body: string
  partialReason?: string
}): string {
  const ready = args.partialReason ? `ready (PARTIAL -- ${args.partialReason})` : 'ready'
  const head = `Recap ${args.recapId} ${ready} -- ${args.projectLabel}, ${args.periodHuman}, ${args.conversationCount} conversation(s).`
  // The agent brief is short by design -- inline it, saving a recap_get
  // round-trip. The human recap is long; send only the pointer.
  if (args.audience === 'agent') return `${head}\n\n${args.body}`
  return `${head} Read it with recap_get({ recapId: "${args.recapId}" }).`
}
