/**
 * Single OpenRouter HTTP client used by:
 *  - recap/away-summary (per-conversation 20-word recap)
 *  - recap/period      (long-form markdown digest)
 *  - voice-stream      (Deepgram refinement pass)
 *
 * Handles bearer auth, deadline-enforced timeout (Promise.race, NOT just
 * AbortController -- a hung provider response was observed to ignore signal
 * abort in Bun), exponential backoff on 5xx, Retry-After honouring on 429,
 * a SEPARATE (smaller) retry budget for timeouts, and normalised usage extraction.
 */

import { NoApiKeyError, OpenRouterError, RateLimitError, TimeoutError } from './errors'
import { type NormalizedUsage, normalizeUsage } from './pricing'

const ENDPOINT = 'https://openrouter.ai/api/v1/chat/completions'
const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_RETRIES = 3

/** One tool call the model emitted (function-call shape). `arguments` is the
 *  raw JSON string the model produced -- the caller parses + validates it. */
export interface ToolCall {
  id: string
  name: string
  arguments: string
}

/** A tool offered to the model. `parameters` is a JSON Schema object (derive it
 *  from a zod schema with z.toJSONSchema). */
export interface ChatTool {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  /** Assistant turn that called tools (round-trips back so the model sees its
   *  own calls alongside the results). */
  toolCalls?: ToolCall[]
  /** A `tool` message: which call this result answers. */
  toolCallId?: string
  /** Mark a prompt-CACHE breakpoint at this message (Anthropic ephemeral cache via
   *  OpenRouter). The provider caches everything UP TO AND INCLUDING this message;
   *  a later request with the same prefix bills those tokens as cacheRead (~10% of
   *  input) instead of full input. Set it on the LAST stable message (e.g. the
   *  leading state block) so only the small mutable tail is re-paid. Backward
   *  compatible: when unset, content stays a plain string and nothing caches. */
  cacheControl?: boolean
}

export interface ChatRequest {
  model: string
  /** WHICH broker feature is spending here (e.g. 'desk-agent', 'recap-period',
   *  'voice-refiner'). REQUIRED so every OpenRouter call is attributable in the
   *  `[openrouter]` cost log -- a call with no owner is un-traceable spend. */
  feature: string
  system?: string
  user?: string
  messages?: ChatMessage[]
  maxTokens?: number
  temperature?: number
  responseFormat?: { type: 'json_object' } | { type: 'text' }
  /** Tools the model may call (function-calling). */
  tools?: ChatTool[]
  /** Tool-choice policy. Default (when tools present) is the provider's 'auto'. */
  toolChoice?: 'auto' | 'none' | 'required'
  timeoutMs?: number
  retries?: number
  /** Retries specifically for a TIMEOUT (the attempt exceeding timeoutMs).
   *  Defaults to `retries`. A slow/hung provider must NOT draw the full
   *  rate-limit retry budget -- e.g. 240s x 3 attempts = 12min of dead air
   *  (the recap-resilience incident). The recap pipeline passes 1. */
  timeoutRetries?: number
  /** Override fetch (test seam). Defaults to globalThis.fetch. */
  fetcher?: typeof fetch
  /** Override env lookup (test seam). Defaults to process.env. */
  apiKey?: string
}

export interface ChatResponse {
  content: string
  /** Tool calls the model emitted this turn (empty/undefined when none). */
  toolCalls?: ToolCall[]
  /** Provider finish reason ('stop' | 'tool_calls' | 'length' | ...). */
  finishReason?: string
  raw: unknown
  usage: NormalizedUsage
  model: string
}

export async function chat(req: ChatRequest): Promise<ChatResponse> {
  const apiKey = resolveApiKey(req)
  const retries = req.retries ?? DEFAULT_RETRIES
  const ctx: AttemptContext = {
    body: buildBody(req),
    fetcher: req.fetcher ?? globalThis.fetch,
    timeoutMs: req.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    apiKey,
    model: req.model,
    maxRetries: retries,
    timeoutRetries: req.timeoutRetries ?? retries,
  }
  const t0 = Date.now()
  try {
    const res = await runWithRetry(ctx)
    recordOpenRouterSpend({ feature: req.feature, model: req.model, ms: Date.now() - t0, ok: true, usage: res.usage })
    return res
  } catch (err) {
    recordOpenRouterSpend({
      feature: req.feature,
      model: req.model,
      ms: Date.now() - t0,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }
}

/** One structured record per OpenRouter round-trip (success OR failure). This
 *  is the shape a future persistence sink (a `openrouter_spend` table / kv
 *  rollup) would store -- keep it self-contained so wiring a DB is a one-line
 *  change inside `recordOpenRouterSpend`, not a call-site refactor. */
interface OpenRouterSpendRecord {
  /** WHICH broker feature spent (the `feature` tag on the ChatRequest). */
  feature: string
  /** Model as REQUESTED (req.model; the response's resolved model lives in usage forensics). */
  model: string
  /** Wall-clock ms for the whole call incl. retries. */
  ms: number
  /** true = billed a usable completion; false = errored/timed-out (no usable tokens). */
  ok: boolean
  /** Normalised token counts + billed cost. Present on success only. */
  usage?: NormalizedUsage
  /** Failure message. Present when ok=false. */
  error?: string
}

/**
 * THE single spend sink. Every `chat()` call -- the one chokepoint every feature
 * passes through -- funnels here, so `docker compose logs broker | grep
 * '\[openrouter\]'` is the whole spend picture and `grep feature=<x>` attributes
 * cost per feature. Today it emits one greppable line; to later persist spend to
 * a DB/kv, add the write HERE and every existing call site is covered for free.
 */
function recordOpenRouterSpend(rec: OpenRouterSpendRecord): void {
  console.log(`[openrouter] ${formatSpendLine(rec)}`)
}

function formatSpendLine(rec: OpenRouterSpendRecord): string {
  const head = `feature=${rec.feature} model=${rec.model} ms=${rec.ms} ok=${rec.ok}`
  if (!rec.ok || !rec.usage) return `${head} err=${rec.error ?? 'unknown'}`
  const u = rec.usage
  const cache =
    u.cacheReadTokens || u.cacheWriteTokens ? ` cache_r=${u.cacheReadTokens} cache_w=${u.cacheWriteTokens}` : ''
  return `${head} in=${u.inputTokens} out=${u.outputTokens}${cache} cost=$${u.costUsd.toFixed(6)} src=${u.costSource}`
}

interface AttemptContext {
  body: Record<string, unknown>
  fetcher: typeof fetch
  timeoutMs: number
  apiKey: string
  model: string
  /** Retry budget for 429/5xx (the general transient-error budget). */
  maxRetries: number
  /** Retry budget for TimeoutError specifically (kept smaller on purpose). */
  timeoutRetries: number
}

// Timeouts and rate-limit/5xx errors draw from SEPARATE budgets: a hung provider
// should not consume the generous transient-error retries (and vice versa). A hard
// ceiling on total attempts guards against an alternating-error stream looping.
// fallow-ignore-next-line complexity
async function runWithRetry(ctx: AttemptContext): Promise<ChatResponse> {
  let timeoutRetriesUsed = 0
  let otherRetriesUsed = 0
  const hardCap = ctx.maxRetries + ctx.timeoutRetries + 1
  for (let total = 0; total < hardCap; total++) {
    try {
      return await attemptOnce(ctx)
    } catch (err) {
      if (!shouldRetry(err)) throw err
      if (err instanceof TimeoutError) {
        if (timeoutRetriesUsed >= ctx.timeoutRetries) throw err
        timeoutRetriesUsed++
        await sleep(backoffMs(timeoutRetriesUsed, err))
      } else {
        if (otherRetriesUsed >= ctx.maxRetries) throw err
        otherRetriesUsed++
        await sleep(backoffMs(otherRetriesUsed, err))
      }
    }
  }
  throw new OpenRouterError('unreachable')
}

function resolveApiKey(req: ChatRequest): string {
  const apiKey = req.apiKey ?? process.env.OPENROUTER_API_KEY
  if (!apiKey) throw new NoApiKeyError()
  return apiKey
}

// fallow-ignore-next-line complexity
function buildBody(req: ChatRequest): Record<string, unknown> {
  const messages = assembleMessages(req)
  if (messages.length === 0) throw new OpenRouterError('chat requires at least one message')
  return {
    model: req.model,
    messages: messages.map(toWireMessage),
    // Opt into OpenRouter's real billed cost + token accounting. Without this
    // the response carries no `usage.cost` and normalizeUsage falls back to a
    // LiteLLM price-table ESTIMATE (costSource='litellm'). With it we get the
    // actual charged amount (costSource='openrouter'). Verified live: the
    // response then includes `usage.cost` and a `cost_details` breakdown.
    usage: { include: true },
    ...(req.maxTokens != null && { max_tokens: req.maxTokens }),
    ...(req.temperature != null && { temperature: req.temperature }),
    ...(req.responseFormat && { response_format: req.responseFormat }),
    ...(req.tools && req.tools.length > 0 && { tools: req.tools.map(toWireTool) }),
    ...(req.toolChoice && { tool_choice: req.toolChoice }),
  }
}

/** OpenAI/OpenRouter function-tool wire shape. */
function toWireTool(t: ChatTool): Record<string, unknown> {
  return { type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }
}

/** Map our ChatMessage to the OpenAI/OpenRouter wire shape, carrying tool_calls
 *  (assistant) and tool_call_id (tool results) when present. */
function toWireMessage(m: ChatMessage): Record<string, unknown> {
  // A cache breakpoint requires the structured content-part shape so the
  // cache_control marker has somewhere to live; plain string content can't carry it.
  const content: unknown = m.cacheControl
    ? [{ type: 'text', text: m.content, cache_control: { type: 'ephemeral' } }]
    : m.content
  const wire: Record<string, unknown> = { role: m.role, content }
  if (m.toolCalls && m.toolCalls.length > 0) {
    wire.tool_calls = m.toolCalls.map(c => ({
      id: c.id,
      type: 'function',
      function: { name: c.name, arguments: c.arguments },
    }))
  }
  if (m.toolCallId) wire.tool_call_id = m.toolCallId
  return wire
}

function assembleMessages(req: ChatRequest): ChatMessage[] {
  const messages: ChatMessage[] = req.messages ? [...req.messages] : []
  if (req.system) messages.unshift({ role: 'system', content: req.system })
  if (req.user) messages.push({ role: 'user', content: req.user })
  return messages
}

/**
 * One HTTP attempt, HARD-bounded by `timeoutMs`. The bound is enforced with a
 * Promise.race against a deadline, not by AbortController alone: a slow/hung
 * provider response (incident: a 707s Bedrock generation against a 240s timeout)
 * was NOT interrupted by `signal` abort in Bun, so the deadline IS the guarantee
 * and `ctrl.abort()` is best-effort socket cleanup layered on top. The race also
 * covers the body read (`res.json()` in parseResponse): headers can arrive
 * promptly while the body streams for minutes, so timing out only the fetch()
 * call would miss exactly the failure mode that bit us.
 */
async function attemptOnce(ctx: AttemptContext): Promise<ChatResponse> {
  const ctrl = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const work = (async (): Promise<ChatResponse> => {
    const res = await ctx.fetcher(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(ctx.body),
      signal: ctrl.signal,
    })
    if (!res.ok) throw await errorForStatus(res)
    return parseResponse(ctx.model, res)
  })()
  // If the deadline wins, `work` keeps running until the leaked socket settles;
  // swallow its late rejection so it never surfaces as an unhandledRejection.
  work.catch(() => {})
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          ctrl.abort()
          reject(new TimeoutError())
        }, ctx.timeoutMs)
      }),
    ])
  } catch (err) {
    if ((err as Error).name === 'AbortError') throw new TimeoutError()
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function errorForStatus(res: Response): Promise<Error> {
  // Read the body on EVERY non-2xx -- a bare status code is undebuggable. The
  // OpenRouter 400 body names the actual reason (bad model slug, param, etc).
  const body = await safeReadBody(res)
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after')
    const retryMs = retryAfter ? Math.max(0, Number(retryAfter)) * 1000 : undefined
    return new RateLimitError(Number.isFinite(retryMs) ? retryMs : undefined)
  }
  const suffix = body ? `: ${body}` : ''
  return new OpenRouterError(
    `OpenRouter returned ${res.status} ${res.statusText}${suffix}`,
    res.status,
    undefined,
    body,
  )
}

/** Read the error body defensively -- never let body-reading mask the original
 *  HTTP error. Truncated so a huge HTML error page can't flood the logs. */
async function safeReadBody(res: Response): Promise<string | undefined> {
  try {
    const text = (await res.text()).trim()
    if (!text) return undefined
    return text.length > 1000 ? `${text.slice(0, 1000)}...[truncated]` : text
  } catch {
    return undefined
  }
}

interface WireToolCall {
  id?: string
  function?: { name?: string; arguments?: string }
}

/** Pull the function-call list off a choice's message into our ToolCall shape. */
function extractToolCalls(raw: WireToolCall[] | undefined): ToolCall[] {
  return (raw ?? [])
    .map((c, i) => ({
      id: c.id ?? `call_${i}`,
      name: c.function?.name ?? '',
      arguments: c.function?.arguments ?? '{}',
    }))
    .filter(c => c.name)
}

// fallow-ignore-next-line complexity
async function parseResponse(model: string, res: Response): Promise<ChatResponse> {
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string; tool_calls?: WireToolCall[] }; finish_reason?: string }>
    usage?: Parameters<typeof normalizeUsage>[1]
    model?: string
  }
  const choice = data.choices?.[0]
  const content = choice?.message?.content?.trim() ?? ''
  const toolCalls = extractToolCalls(choice?.message?.tool_calls)
  // A tool-calling turn legitimately has empty content -- only error when the
  // model returned NOTHING usable (no text AND no tool calls).
  if (!content && toolCalls.length === 0) throw new OpenRouterError('OpenRouter returned an empty completion')
  return {
    content,
    ...(toolCalls.length > 0 && { toolCalls }),
    ...(choice?.finish_reason && { finishReason: choice.finish_reason }),
    raw: data,
    usage: normalizeUsage(model, data.usage),
    model: data.model ?? model,
  }
}

// fallow-ignore-next-line complexity
function shouldRetry(err: unknown): boolean {
  if (err instanceof RateLimitError) return true
  if (err instanceof TimeoutError) return true
  if (err instanceof OpenRouterError) {
    return err.status != null && err.status >= 500
  }
  return false
}

function backoffMs(attempt: number, err: unknown): number {
  if (err instanceof RateLimitError && err.retryAfterMs != null) return err.retryAfterMs
  return Math.min(8000, 250 * 2 ** (attempt - 1))
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms))
}
