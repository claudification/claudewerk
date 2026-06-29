/**
 * Disposition classifier (plan-dispatcher-build.md §4 + §9).
 *
 * Takes an INTENT + a roster of conversations and decides a DISPOSITION:
 *   new    -- spawn a fresh conversation
 *   route  -- inject the message into an existing live conversation
 *   revive -- reopen an ended conversation and route into it
 *   ask    -- unsure: surface candidate cards for one-click select
 *
 * Lean v1 (a faithful, much-smaller subset of Front Desk D4): override-first ->
 * roster -> ONE cheap LLM call -> ambiguity gate. NO memfs, NO eval harness, NO
 * prefilter scoring machinery. The dispatcher holds a SHORT context window; the
 * roster is the only context the model sees.
 *
 * Pure + injectable: the LLM call comes in as a `ChatFn` so this is unit-tested
 * without network. The orchestrator wires the real roster + `chat`.
 */

import type { DispatchCandidate, DispatchCostSignal, DispatchDisposition } from '../../shared/protocol'
import type { ChatRequest, ChatResponse } from '../recap/shared/openrouter-client'
import { computeCostSignal } from './cost'

export type ChatFn = (req: ChatRequest) => Promise<ChatResponse>

/** A conversation the dispatcher could route/revive into. Metrics are read off
 *  the existing Conversation record; `liveState` is status-tool's LiveStatus
 *  when the feed is available (else undefined -> we fall back gracefully). */
export interface DispatchRosterEntry {
  conversationId: string
  project?: string
  title?: string
  /** Ended conversations are revive candidates, not route candidates. */
  ended?: boolean
  /** True when the conversation is currently running (context is hot). */
  isActive?: boolean
  liveState?: string
  contextTokens?: number
  idleMs?: number
  model?: string
}

export interface ClassifyInput {
  intent: string
  /** Explicit target (conversationId or project) -> override-first. */
  target?: string
  /** Explicit disposition override -> honored without an LLM call. */
  dispositionHint?: DispatchDisposition
  roster: DispatchRosterEntry[]
}

export interface ClassifyResult {
  disposition: DispatchDisposition
  target?: string
  confidence: number
  reasoning: string
  candidates?: DispatchCandidate[]
  cost?: DispatchCostSignal
}

export const CLASSIFY_MODEL = 'anthropic/claude-haiku-4.5'
export const AMBIGUITY_THRESHOLD = 0.55
const MAX_CANDIDATES = 4

export async function classifyDispatch(input: ClassifyInput, chat: ChatFn): Promise<ClassifyResult> {
  const override = tryOverride(input)
  if (override) return override

  let parsed: LlmDecision
  try {
    const res = await chat({
      model: CLASSIFY_MODEL,
      system: SYSTEM_PROMPT,
      user: buildUserPrompt(input),
      responseFormat: { type: 'json_object' },
      maxTokens: 400,
      temperature: 0,
      timeoutMs: 20_000,
      timeoutRetries: 1,
    })
    parsed = parseDecision(res.content)
  } catch (e) {
    // LLM unreachable -> never silently misroute. Ask the user.
    return askResult(input, `classifier unavailable (${(e as Error).message})`)
  }

  return finalize(input, parsed)
}

// ─── Override-first ─────────────────────────────────────────────────

function tryOverride(input: ClassifyInput): ClassifyResult | null {
  const { dispositionHint, target } = input

  if (dispositionHint && dispositionHint !== 'ask') {
    const entry = target ? findEntry(input.roster, target) : undefined
    return {
      disposition: dispositionHint,
      target,
      confidence: 1,
      reasoning: 'explicit disposition override',
      cost: entry ? entryCost(entry) : undefined,
    }
  }

  if (target) {
    const entry = findEntry(input.roster, target)
    if (entry) {
      return {
        disposition: entry.ended ? 'revive' : 'route',
        target,
        confidence: 1,
        reasoning: `explicit target conversation (${entry.ended ? 'ended -> revive' : 'live -> route'})`,
        cost: entryCost(entry),
      }
    }
    // A target that isn't a known conversation is treated as a project -> spawn.
    return { disposition: 'new', target, confidence: 1, reasoning: 'explicit project target -> spawn' }
  }

  return null
}

// ─── LLM path ───────────────────────────────────────────────────────

interface LlmDecision {
  disposition: DispatchDisposition
  target?: string
  confidence: number
  reasoning: string
}

const SYSTEM_PROMPT = [
  'You are the front desk concierge for a fleet of coding conversations. Decide',
  'what an incoming message needs. Reply ONLY with JSON:',
  '{ "disposition": "converse"|"new"|"route"|"revive"|"ask",',
  '  "target": <conversationId or null>, "confidence": 0..1, "reasoning": <one sentence> }.',
  'Rules:',
  '- CONVERSE FIRST: if the user is talking TO you -- a greeting, "what\'s going on",',
  '  a status/overview question, thanks, or any chit-chat that does NOT ask to start',
  '  or continue actual coding work -- use "converse". You answer them directly; no',
  '  conversation is spawned or routed.',
  '- Otherwise it is WORK. SPAWN-BIAS: prefer "new" unless the intent clearly',
  '  continues an in-progress topic AND a candidate conversation is fresh (low idle)',
  '  AND matches well.',
  '- "route" targets a LIVE conversation; "revive" targets an ENDED one.',
  '- If two work candidates are close, or nothing matches well, use "ask".',
  '- Never invent a target id; use one from the roster or null.',
].join('\n')

function buildUserPrompt(input: ClassifyInput): string {
  const roster = input.roster.slice(0, 30).map(e => ({
    id: e.conversationId,
    project: e.project,
    title: e.title,
    state: e.ended ? 'ended' : (e.liveState ?? 'live'),
    idleMin: e.idleMs !== undefined ? Math.round(e.idleMs / 60000) : undefined,
    ctxK: e.contextTokens !== undefined ? Math.round(e.contextTokens / 1000) : undefined,
  }))
  return `INTENT:\n${input.intent}\n\nROSTER (candidate conversations):\n${JSON.stringify(roster, null, 2)}`
}

/** Extract the JSON object from a model reply that may wrap it in a ```json
 *  fence or surround it with prose (Haiku does this even with json_object). */
function extractJson(content: string): string {
  const t = content.trim()
  const fenced = t.match(/```(?:json)?\s*([\s\S]*?)\s*```/i)
  if (fenced?.[1]) return fenced[1].trim()
  const first = t.indexOf('{')
  const last = t.lastIndexOf('}')
  if (first !== -1 && last > first) return t.slice(first, last + 1)
  return t
}

function parseDecision(content: string): LlmDecision {
  const raw = JSON.parse(extractJson(content)) as Partial<LlmDecision>
  const disposition = raw.disposition
  if (
    disposition !== 'new' &&
    disposition !== 'route' &&
    disposition !== 'revive' &&
    disposition !== 'ask' &&
    disposition !== 'converse'
  ) {
    throw new Error(`bad disposition: ${String(disposition)}`)
  }
  const confidence = typeof raw.confidence === 'number' ? Math.max(0, Math.min(1, raw.confidence)) : 0
  return {
    disposition,
    target: raw.target ?? undefined,
    confidence,
    reasoning: typeof raw.reasoning === 'string' ? raw.reasoning : '',
  }
}

function finalize(input: ClassifyInput, d: LlmDecision): ClassifyResult {
  // Conversational / status intent -> the concierge answers directly. Never gate
  // to candidate cards; a greeting isn't a routing ambiguity.
  if (d.disposition === 'converse') {
    return { disposition: 'converse', confidence: d.confidence, reasoning: d.reasoning }
  }

  // Ambiguity gate: low confidence OR the model asked -> surface cards.
  if (d.disposition === 'ask' || d.confidence < AMBIGUITY_THRESHOLD) {
    return askResult(input, d.reasoning || 'low confidence -- asking the user')
  }

  // route/revive must name a real roster entry; if it doesn't, degrade to ask.
  if (d.disposition === 'route' || d.disposition === 'revive') {
    const entry = d.target ? findEntry(input.roster, d.target) : undefined
    if (!entry) return askResult(input, `model named an unknown target (${String(d.target)})`)
    return {
      disposition: entry.ended ? 'revive' : 'route',
      target: d.target,
      confidence: d.confidence,
      reasoning: d.reasoning,
      cost: entryCost(entry),
    }
  }

  // new
  return { disposition: 'new', target: d.target, confidence: d.confidence, reasoning: d.reasoning }
}

// ─── Ambiguity / candidates ─────────────────────────────────────────

function askResult(input: ClassifyInput, reasoning: string): ClassifyResult {
  return {
    disposition: 'ask',
    confidence: 0,
    reasoning,
    candidates: input.roster.slice(0, MAX_CANDIDATES).map(rosterEntryToCandidate),
  }
}

function rosterEntryToCandidate(e: DispatchRosterEntry): DispatchCandidate {
  const cost = entryCost(e)
  const c: DispatchCandidate = { conversationId: e.conversationId, cost }
  if (e.project !== undefined) c.project = e.project
  if (e.title !== undefined) c.title = e.title
  if (e.liveState !== undefined) c.liveState = e.liveState
  c.commentary = buildCommentary(e, cost)
  return c
}

function buildCommentary(e: DispatchRosterEntry, cost: DispatchCostSignal): string {
  const bits: string[] = []
  bits.push(e.ended ? 'ended (revive)' : (e.liveState ?? 'live'))
  if (e.idleMs !== undefined) bits.push(`idle ${Math.round(e.idleMs / 60000)}m`)
  if (cost.tier !== 'cheap') bits.push(cost.tier.replace('_', ' '))
  return bits.join(' · ')
}

// ─── Helpers ────────────────────────────────────────────────────────

function findEntry(roster: DispatchRosterEntry[], id: string): DispatchRosterEntry | undefined {
  return roster.find(e => e.conversationId === id)
}

function entryCost(e: DispatchRosterEntry): DispatchCostSignal {
  return computeCostSignal({ contextTokens: e.contextTokens, idleMs: e.idleMs, model: e.model, isActive: e.isActive })
}
