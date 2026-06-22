/**
 * The LIVING HISTORY engine -- the heart of the dispatcher (Jonas, 2026-06-23).
 *
 * The LLM is stateless: every turn we resubmit the whole message array, so that
 * array is OURS to REWRITE each turn, not a log we append to. The dispatcher is
 * therefore a LIVING conversation whose context we MUTATE as things happen --
 * NOT a single-shot snapshot loop and NOT an append-only TanStack/Vercel array.
 *
 * The history holds two kinds of entry:
 *  - BLOCKS: addressable, mutable, XML-tagged state -- `<fleet>`, `<memory>`,
 *    `<pending id>`, `<findings id>`. Async results arrive as a block MUTATION
 *    (rewrite `<pending q1>` into `<findings q1>` in place), which IS the impulse.
 *  - TURNS: the dialogue (user impulses + dispatcher replies), timestamped.
 *
 * Context is bounded by TIME, not length: turns older than ~1h phase out and
 * condense into memory (consolidate.ts), so the history shrinks as it ages. This
 * module is the pure data structure + mutation API + serialization + the
 * consolidation POLICY (when to fold). The LLM fold itself lives in consolidate.ts.
 */

import type { ChatMessage } from '../recap/shared/openrouter-client'

export type Role = 'user' | 'assistant'

export interface Turn {
  kind: 'turn'
  role: Role
  content: string
  ts: number
}

export interface Block {
  kind: 'block'
  /** Stable address -- mutating the same id rewrites the block in place. */
  id: string
  /** XML tag the block renders as (`fleet`, `memory`, `pending`, `findings`). */
  tag: string
  content: string
  ts: number
}

export interface LivingHistory {
  /** Addressable state blocks, insertion-ordered (a Map preserves order; an
   *  in-place upsert keeps the block's slot -- pending->findings stays put). */
  blocks: Map<string, Block>
  turns: Turn[]
}

export function createHistory(): LivingHistory {
  return { blocks: new Map(), turns: [] }
}

// ─── Mutations ──────────────────────────────────────────────────────

/** Append a dialogue turn (a user impulse or the dispatcher's reply). */
export function appendTurn(h: LivingHistory, role: Role, content: string, ts: number): void {
  h.turns.push({ kind: 'turn', role, content, ts })
}

/** Create or REWRITE a state block by id. This is THE mutation -- e.g. turning
 *  `<pending q1>` into `<findings q1>` when async work reports back. */
export function upsertBlock(h: LivingHistory, id: string, tag: string, content: string, ts: number): void {
  h.blocks.set(id, { kind: 'block', id, tag, content, ts })
}

export function dropBlock(h: LivingHistory, id: string): void {
  h.blocks.delete(id)
}

export function getBlock(h: LivingHistory, id: string): Block | undefined {
  return h.blocks.get(id)
}

// ─── Serialization (history -> the message array we submit) ─────────

function renderBlock(b: Block): string {
  return `<${b.tag} id="${b.id}">\n${b.content}\n</${b.tag}>`
}

/** Render the living history into the LLM message array: one leading state
 *  message carrying all current blocks (the mutable working memory), then the
 *  dialogue turns in order. The system prompt is passed to chat() separately. */
export function toMessages(h: LivingHistory): ChatMessage[] {
  const messages: ChatMessage[] = []
  if (h.blocks.size > 0) {
    const state = [...h.blocks.values()].map(renderBlock).join('\n')
    messages.push({ role: 'user', content: state })
  }
  for (const t of h.turns) messages.push({ role: t.role, content: t.content })
  return messages
}

/** Rough token estimate (chars/4) over the whole history -- drives the size valve. */
export function estimateTokens(h: LivingHistory): number {
  let chars = 0
  for (const b of h.blocks.values()) chars += b.content.length + b.tag.length * 2 + b.id.length
  for (const t of h.turns) chars += t.content.length
  return Math.ceil(chars / 4)
}

// ─── Consolidation policy (WHEN to fold; the LLM fold is consolidate.ts) ─────

export const ONE_HOUR_MS = 60 * 60_000
export const TEN_MIN_MS = 10 * 60_000
/** Above this, condense FASTER (bypass the interval) -- cost + context-window. */
export const DEFAULT_SIZE_TOKEN_LIMIT = 6000
/**
 * The time-path FLOOR (§8a, measured 2026-06-23). Below this many tokens the
 * time trigger does NOT fold even when turns have aged out -- a fold is its own
 * LLM call (~$0.001) and the input it would save on a tiny history is fractions
 * of a cent, so eager folding is a NET LOSS. Cheap/quiet sessions just let aged
 * turns linger (capped by the size valve) until there's enough to be worth a
 * call. The size valve still bypasses this. Set to 0 to test the pure time path.
 */
export const DEFAULT_MIN_SIZE_FOR_TIME_TRIGGER = 1500

/** Turns aged past the phase-out horizon -- these condense into memory + drop. */
export function agedTurns(h: LivingHistory, now: number, maxAgeMs = ONE_HOUR_MS): Turn[] {
  return h.turns.filter(t => now - t.ts >= maxAgeMs)
}

export interface ConsolidatePolicyInput {
  history: LivingHistory
  now: number
  lastRunAt: number
  maxAgeMs?: number
  minIntervalMs?: number
  sizeTokenLimit?: number
  /** Min history size (tokens) for the TIME path to fire (§8a). Default 1500. */
  minSizeForTimeTrigger?: number
}

/**
 * Decide whether to run the (expensive) consolidation fold now.
 *  - SHORT-CIRCUIT: nothing aged out AND not over size -> false (no LLM cost).
 *  - SIZE VALVE: over the token limit -> true, even before the interval elapses.
 *  - TIME: aged-out turns exist, the history is big enough to be WORTH a fold
 *    (>= the size floor, §8a -- eager folding of tiny histories is a net cost
 *    loss), AND it's been >= the min interval.
 */
export function shouldConsolidate(input: ConsolidatePolicyInput): boolean {
  const { history, now, lastRunAt } = input
  const minIntervalMs = input.minIntervalMs ?? TEN_MIN_MS
  const sizeTokenLimit = input.sizeTokenLimit ?? DEFAULT_SIZE_TOKEN_LIMIT
  const minSizeForTime = input.minSizeForTimeTrigger ?? DEFAULT_MIN_SIZE_FOR_TIME_TRIGGER

  const tokens = estimateTokens(history)
  const tooBig = tokens > sizeTokenLimit
  const hasAged = agedTurns(history, now, input.maxAgeMs).length > 0
  if (!hasAged && !tooBig) return false // short-circuit: nothing to do, no cost
  if (tooBig) return true // size valve bypasses both the floor and the interval
  if (tokens < minSizeForTime) return false // too small to be worth an LLM fold
  return now - lastRunAt >= minIntervalMs
}
