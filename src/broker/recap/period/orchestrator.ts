import { createHash } from 'node:crypto'
import type { RecapAudience, RecapCreateMessage, RecapLedgerStage, RecapSignal } from '../../../shared/protocol'
import type { StoreDriver } from '../../store/types'
import { type ChatRequest, chat } from '../shared/openrouter-client'
import type { NormalizedUsage } from '../shared/pricing'
import { buildMapPrompt, MapParseError, parseMapOutput } from './chunk/map-prompt'
import { makeEmptyMetadata, mergeMetadata } from './chunk/merge'
import { type RecapRenderMode, shouldChunk, splitIntoChunks } from './chunk/split'
import { buildSynthesizePrompt } from './chunk/synthesize-prompt'
import {
  gatherCommitsStub,
  gatherConversations,
  gatherCost,
  gatherErrors,
  gatherOpenQuestions,
  gatherTasks,
  gatherToolUse,
  gatherTranscripts,
  type PeriodScope,
} from './gather'
import type { CommitDigest } from './gather/types'
import { RecapLedger } from './ledger'
import { chunkModels, pickModel } from './llm/escalate'
import { buildPrompt, type PromptInputs } from './llm/prompt-builder'
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
  const audience: RecapAudience = args.audience ?? 'human'
  const signals = resolveSignals(args, audience)
  // audience is folded into the cache key: a human and an agent recap for
  // the same project+period+signals are different documents.
  const signalsHash = sha256([args.projectUri, period.start, period.end, audience, signals.join(',')].join('|'))

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
): void {
  setImmediate(() => {
    // The ledger lives at this scope so the failure path can persist whatever
    // cost was already burned (record-on-failure) -- the runLlmCall wrapper
    // also flushes it incrementally, but this guarantees the final state.
    const ledger = new RecapLedger()
    runRecap(deps, recapId, args, period, timeZone, ledger).catch(err => {
      console.error(`[recap] run failed for ${recapId}:`, err)
      const built = ledger.build()
      deps.store.update(recapId, {
        status: 'failed',
        error: describe(err),
        ledgerJson: JSON.stringify(built),
        inputTokens: built.summary.totalInputTokens,
        outputTokens: built.summary.totalOutputTokens,
        llmCostUsd: built.summary.totalCostUsd,
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

// fallow-ignore-next-line complexity
async function runRecap(
  deps: OrchestratorDeps,
  recapId: string,
  args: StartArgs,
  period: ResolvedPeriod,
  timeZone: string,
  ledger: RecapLedger,
): Promise<void> {
  const emit = createProgressEmitter({ recapId, store: deps.store, broadcaster: deps.broadcaster })
  emit.setStatus('gathering')
  emit.setProgress(2, 'gather/begin')
  deps.store.update(recapId, { startedAt: Date.now() })

  const projectUris = (deps.expandProjectScope ?? defaultExpand)(args.projectUri)
  const scope: PeriodScope = { projectUris, periodStart: period.start, periodEnd: period.end, timeZone }

  const audience: RecapAudience = args.audience ?? 'human'
  const includeInternals = resolveSignals(args, audience).includes('turn_internals')
  const { promptInputs, inputChars } = collectSignals(
    deps,
    scope,
    period,
    args.projectUri,
    deps.projectLabel,
    includeInternals,
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
  emit.setProgress(35, 'gather/done')

  const built = buildPrompt(promptInputs, audience)
  emit.setStatus('rendering')
  // ONESHOT for small periods (one Opus pass), CHUNKED map-reduce for big ones
  // (parallel cheap extraction -> code merge -> one Opus synthesis). Both feed
  // the SAME parseRecapOutput/finalize downstream.
  const { parsed, model } = await produceRecap(deps, recapId, ledger, emit, { built, promptInputs, audience, args })
  const titleTemplate = `${promptInputs.projectLabel} - ${period.human}`
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
  })

  const digest = buildRecapDigest({
    cost: promptInputs.cost,
    conversations: promptInputs.conversations,
    commits: promptInputs.commits,
  })

  finalize(deps, recapId, ledger, {
    title: titleTemplate,
    subtitle: parsed.metadata.subtitle,
    markdown: finalMarkdown,
    metadata: parsed.metadata,
    digestJson: JSON.stringify(digest),
    body: parsed.body,
    projectUri: args.projectUri,
  })
  emit.setProgress(100, 'persist')
  emit.setStatus('done')
  emit.emit('info', 'persist', `recap stored as ${recapId}`)
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
): { promptInputs: PromptInputs; inputChars: number } {
  const conversations = gatherConversations(deps.brokerStore, scope)
  const transcripts = gatherTranscripts(deps.brokerStore, conversations, scope, includeInternals)
  const cost = gatherCost(deps.brokerStore, scope)
  const tasks = gatherTasks(deps.brokerStore, conversations, scope)
  const tools = gatherToolUse(deps.brokerStore, conversations, scope)
  const errors = gatherErrors(deps.brokerStore, conversations, scope)
  const openQuestions = gatherOpenQuestions(deps.brokerStore, conversations, scope)
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
    commits,
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
const RECAP_TIMEOUT_MS = 240_000

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
  try {
    const res = await chat(req)
    ledger.addCall({ stage, model: req.model, usage: res.usage, ms: Date.now() - t0, ...idx })
    flushLedger(deps, recapId, ledger)
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
    throw err
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
): Promise<string> {
  return runLlmCall(deps, recapId, ledger, 'oneshot', {
    model,
    system: prompt.system,
    user: prompt.user,
    maxTokens: RECAP_MAX_TOKENS,
    timeoutMs: RECAP_TIMEOUT_MS,
    temperature: 0.2,
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
      model,
      apiKey,
      retries: 1,
      maxTokens: RECAP_MAX_TOKENS,
      timeoutMs: RECAP_TIMEOUT_MS,
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

interface ProduceArgs {
  built: { system: string; user: string; inputChars: number }
  promptInputs: PromptInputs
  audience: RecapAudience
  args: StartArgs
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
): Promise<{ parsed: ParsedRecap; model: string }> {
  const { built, promptInputs, audience } = p
  deps.store.update(recapId, { inputChars: built.inputChars })
  const chunked = shouldChunk(built.inputChars, promptInputs.conversations.length, { forceMode: forceModeOf(p.args) })
  if (chunked) return runChunked(deps, recapId, ledger, emit, p)

  const choice = pickModel(built.inputChars, audience)
  deps.store.update(recapId, { model: choice.model })
  emit.emit(
    'info',
    'render/prompt',
    `oneshot model=${choice.model} (${choice.reason}), prompt=${built.inputChars} chars`,
  )
  emit.setProgress(45, 'render/llm')
  const content = await callLlm(deps, recapId, ledger, built, choice.model, deps.apiKey)
  emit.setProgress(85, 'render/llm-done')
  const parsed = await parseOrRetry(deps, recapId, ledger, content, built, choice.model, deps.apiKey)
  return { parsed, model: choice.model }
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
): Promise<{ parsed: ParsedRecap; model: string }> {
  const { built, promptInputs, audience } = p
  const models = chunkModels({
    mapModel: overrideOf(p.args, 'mapModel'),
    reduceModel: overrideOf(p.args, 'reduceModel'),
  })
  const chunks = splitIntoChunks(promptInputs.transcripts)
  deps.store.update(recapId, { model: models.reduceModel })
  emit.emit(
    'info',
    'render/chunk',
    `chunked map-reduce: ${chunks.length} chunk(s), map=${models.mapModel}, reduce=${models.reduceModel}, prompt=${built.inputChars} chars`,
  )
  emit.setProgress(45, 'render/map')

  // MAP -- parallel extraction. A chunk that fails to call or parse degrades to
  // empty metadata (logged); the run only fails if EVERY chunk failed, so we
  // never silently drop the whole period over one bad chunk.
  let failed = 0
  const metas = await parallelMap(chunks, MAP_CONCURRENCY, async chunk => {
    const prompt = buildMapPrompt(chunk)
    const phase = `render/map ${chunk.index + 1}/${chunks.length}`
    emit.emit(
      'info',
      phase,
      `mapping chunk ${chunk.index + 1}/${chunks.length} (${chunk.chars} chars, ${chunk.transcripts.length} conv)`,
    )
    let content: string
    try {
      content = await runLlmCall(
        deps,
        recapId,
        ledger,
        'map',
        {
          model: models.mapModel,
          system: prompt.system,
          user: prompt.user,
          responseFormat: { type: 'json_object' },
          maxTokens: RECAP_MAX_TOKENS,
          timeoutMs: RECAP_TIMEOUT_MS,
          temperature: 0.1,
          retries: 2,
          apiKey: deps.apiKey,
        },
        chunk.index,
      )
    } catch (err) {
      failed++
      emit.emit('warn', phase, `chunk ${chunk.index + 1} map call failed: ${describe(err)}`)
      return makeEmptyMetadata()
    }
    try {
      return parseMapOutput(content)
    } catch (err) {
      if (!(err instanceof MapParseError)) throw err
      failed++
      emit.emit('warn', phase, `chunk ${chunk.index + 1} map JSON unparseable: ${describe(err)}`)
      return makeEmptyMetadata()
    }
  })
  if (failed === chunks.length) {
    throw new Error(`chunked map stage failed: all ${chunks.length} chunk(s) errored`)
  }
  if (failed > 0) {
    emit.emit('warn', 'render/map-done', `${failed}/${chunks.length} chunk(s) failed; synthesizing from the rest`)
  }

  // MERGE -- pure deterministic dedup, no LLM.
  emit.setProgress(72, 'render/merge')
  const merged = mergeMetadata(metas)
  emit.emit('info', 'render/merge', `merged ${chunks.length} chunk(s) -> ${countItems(merged)} item(s) after dedup`)

  // REDUCE -- one synthesis pass on the small merged JSON (not the raw bulk).
  emit.setProgress(78, 'render/synthesize')
  const synth = buildSynthesizePrompt(
    merged,
    {
      projectLabel: promptInputs.projectLabel,
      periodHuman: promptInputs.periodHuman,
      periodIsoRange: promptInputs.periodIsoRange,
    },
    audience,
  )
  const content = await runLlmCall(deps, recapId, ledger, 'reduce', {
    model: models.reduceModel,
    system: synth.system,
    user: synth.user,
    maxTokens: RECAP_MAX_TOKENS,
    timeoutMs: RECAP_TIMEOUT_MS,
    temperature: 0.2,
    retries: 2,
    apiKey: deps.apiKey,
  })
  emit.setProgress(88, 'render/synthesize-done')
  const parsed = await parseOrRetry(deps, recapId, ledger, content, synth, models.reduceModel, deps.apiKey)
  return { parsed, model: models.reduceModel }
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
    m.gotchas.length
  )
}

/** Pillar-D forceMode seam: read an optional render-mode override off the create
 *  args (the MCP schema wires this in Pillar D; absent today -> undefined). */
function forceModeOf(args: StartArgs): RecapRenderMode | undefined {
  const m = (args as { forceMode?: string }).forceMode
  return m === 'oneshot' || m === 'chunked' || m === 'auto' ? m : undefined
}

/** Pillar-D per-call model override seam (string fields on the create args). */
function overrideOf(args: StartArgs, key: 'mapModel' | 'reduceModel'): string | undefined {
  const v = (args as unknown as Record<string, unknown>)[key]
  return typeof v === 'string' && v.trim() ? v.trim() : undefined
}

interface FinalizeArgs {
  title: string
  subtitle?: string
  markdown: string
  metadata: RecapMetadata
  digestJson: string
  body: string
  projectUri: string
}

function finalize(deps: OrchestratorDeps, recapId: string, ledger: RecapLedger, args: FinalizeArgs): void {
  // Aggregate token/cost columns + the full ledger now derive from COST 2
  // (every call this run), so they include the retry call the old code dropped.
  const built = ledger.build()
  deps.store.update(recapId, {
    status: 'done',
    progress: 100,
    completedAt: Date.now(),
    title: args.title,
    subtitle: args.subtitle ?? null,
    markdown: args.markdown,
    metadataJson: JSON.stringify(args.metadata),
    digestJson: args.digestJson,
    inputTokens: built.summary.totalInputTokens,
    outputTokens: built.summary.totalOutputTokens,
    llmCostUsd: built.summary.totalCostUsd,
    ledgerJson: JSON.stringify(built),
  })
  const tags = denormalizeTags(recapId, args.metadata)
  deps.store.setTags(recapId, tags)
  deps.store.upsertFts(recapId, buildFtsFields(args.metadata, args.body, args.projectUri, args.title))
}

function rowToMeta(deps: OrchestratorDeps, recapId: string) {
  const row = deps.store.get(recapId)
  if (!row) throw new Error(`recap ${recapId} missing after finalize`)
  return rowToRecapMeta(row)
}

function defaultExpand(projectUri: string): string[] {
  return [projectUri]
}

function defaultLabel(projectUri: string): string {
  if (projectUri === '*') return 'all projects'
  const match = projectUri.match(/[^/]+$/)
  return match ? match[0] : projectUri
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
 * Resolve the effective signal set. Explicit `args.signals` win verbatim.
 * Otherwise default per audience: the agent brief opts `turn_internals` in
 * (it backs the "Dead ends" section); the human recap does not.
 */
function resolveSignals(args: StartArgs, audience: RecapAudience): RecapSignal[] {
  if (args.signals) return args.signals.slice().sort()
  const base = DEFAULT_SIGNALS.slice()
  if (audience === 'agent') base.push('turn_internals')
  return base.sort()
}

/** Build the recap-completed channel message text pushed to the caller. */
function buildInformText(args: {
  recapId: string
  audience: RecapAudience
  projectLabel: string
  periodHuman: string
  conversationCount: number
  body: string
}): string {
  const head = `Recap ${args.recapId} ready -- ${args.projectLabel}, ${args.periodHuman}, ${args.conversationCount} conversation(s).`
  // The agent brief is short by design -- inline it, saving a recap_get
  // round-trip. The human recap is long; send only the pointer.
  if (args.audience === 'agent') return `${head}\n\n${args.body}`
  return `${head} Read it with recap_get({ recapId: "${args.recapId}" }).`
}
