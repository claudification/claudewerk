/**
 * The CONSOLIDATION FOLD -- the LLM side of the living-history phase-out policy.
 *
 * `living-history.ts` owns the POLICY (`shouldConsolidate`: 1h horizon, ≤10min
 * interval, size valve, short-circuit). THIS is the action the policy authorizes:
 * take the dialogue turns that aged past the phase-out horizon, fold their durable
 * substance into the rolling `<memory>` block, and DROP them from the raw history.
 * That is how the context shrinks as it ages -- old turns become a few lines of
 * memory instead of verbatim transcript.
 *
 * Pure-ish: the LLM call is injected as a `ChatFn`, so this is unit-testable with
 * a stub. On any LLM failure we keep BOTH the existing memory and the aged turns
 * (no regression, no silent loss) -- a later tick retries the fold.
 *
 * Model is configurable (§5): the live fold defaults to a cheap tier; the §8
 * experiments decide whether Haiku is accurate enough or the fold needs Opus.
 */

import type { ChatFn } from './classify'
import { agedTurns, type LivingHistory, type Turn, upsertBlock } from './living-history'

/** The single rolling memory block id -- the fold always rewrites this slot. */
export const MEMORY_BLOCK_ID = 'memory'

/** Default fold model. Cheap by design; override per §5 (the digest/dream-cycle
 *  pass may want Opus). The §8 experiments quantify Haiku-vs-Sonnet accuracy. */
export const CONSOLIDATE_MODEL = 'anthropic/claude-haiku-4.5'

/** The rolling memory must stay small -- it rides in the context EVERY turn. */
export const MAX_MEMORY_CHARS = 2000

const SYSTEM = [
  "You maintain a TINY rolling MEMORY for a dispatcher that fields a user's",
  "requests across a fleet of dev projects. The memory is the dispatcher's",
  'long-term recollection of what the user has been doing and asking about.',
  'You are given the CURRENT memory plus the OLDEST dialogue turns, which are now',
  'aging out of the live window and must be folded into memory before they drop.',
  'Rewrite the memory, integrating what is DURABLE from those turns. Rules:',
  '- Keep durable facts: standing preferences, ongoing threads, decisions made,',
  '  unresolved questions, which projects/topics the user cares about.',
  '- DROP transient chatter: greetings, acknowledgements, one-off lookups already',
  '  answered, anything with no lasting relevance.',
  '- SUPERSEDE outdated state -- replace it, do not append. Memory must NOT grow',
  '  unboundedly; when it nears the cap, compress older entries harder.',
  '- If the aging turns add nothing durable, return the current memory unchanged.',
  `- Output PLAIN markdown bullets, under ${MAX_MEMORY_CHARS} characters, NO`,
  '  preamble, NO "Memory:" header. Just the content.',
].join('\n')

export interface ConsolidateInput {
  history: LivingHistory
  now: number
  /** Override the phase-out horizon (defaults to 1h via agedTurns). */
  maxAgeMs?: number
  model?: string
  maxMemoryChars?: number
}

export interface ConsolidateResult {
  /** True iff the fold ran AND succeeded (memory rewritten, aged turns dropped). */
  ran: boolean
  /** How many aged turns were folded + dropped (0 when nothing aged or on failure). */
  foldedTurns: number
  /** Size of the memory block after the fold (chars). */
  memoryChars: number
  /** Token/cost usage of the fold call (absent when no LLM call was made). */
  usage?: Awaited<ReturnType<ChatFn>>['usage']
  model?: string
}

function currentMemory(h: LivingHistory): string {
  return h.blocks.get(MEMORY_BLOCK_ID)?.content ?? ''
}

function buildUser(memory: string, aging: Turn[]): string {
  const transcript = aging.map(t => `${t.role.toUpperCase()}: ${t.content}`).join('\n')
  return [
    memory ? `CURRENT MEMORY:\n${memory}` : 'CURRENT MEMORY: (none yet)',
    `AGING TURNS (fold these in, then they will be dropped):\n${transcript}`,
  ].join('\n\n')
}

/** Remove the given turns (by identity) from the live history -- they have been
 *  folded into memory, so the raw verbatim copy is no longer carried. */
function dropTurns(h: LivingHistory, aged: Turn[]): void {
  const drop = new Set<Turn>(aged)
  h.turns = h.turns.filter(t => !drop.has(t))
}

/** Trim + hard-cap text to `max` chars with an ellipsis. Shared with the
 *  dream-cycle (both cap the rewritten `<memory>` block the same way). */
export function cap(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t
}

/**
 * Fold aged-out turns into the rolling `<memory>` block, then drop them.
 * Returns `ran:false` (a no-op) when nothing has aged out OR the LLM fold fails,
 * so callers never lose turns to a transient model error.
 */
export async function consolidate(input: ConsolidateInput, chat: ChatFn): Promise<ConsolidateResult> {
  const { history, now } = input
  const maxMemoryChars = input.maxMemoryChars ?? MAX_MEMORY_CHARS
  const aged = agedTurns(history, now, input.maxAgeMs)
  if (aged.length === 0) {
    return { ran: false, foldedTurns: 0, memoryChars: currentMemory(history).length }
  }

  const memory = currentMemory(history)
  try {
    const res = await chat({
      feature: 'desk-consolidate',
      model: input.model ?? CONSOLIDATE_MODEL,
      system: SYSTEM,
      user: buildUser(memory, aged),
      maxTokens: 800,
      temperature: 0,
      timeoutMs: 25_000,
      timeoutRetries: 0,
    })
    const next = cap(res.content, maxMemoryChars)
    // Even an "unchanged" fold legitimately drops the aged turns: their substance
    // is already represented (the model judged they added nothing durable).
    if (next) upsertBlock(history, MEMORY_BLOCK_ID, 'memory', next, now)
    dropTurns(history, aged)
    return {
      ran: true,
      foldedTurns: aged.length,
      memoryChars: currentMemory(history).length,
      usage: res.usage,
      model: res.model,
    }
  } catch {
    // Keep memory AND the aged turns -- a later tick retries. No silent loss.
    return { ran: false, foldedTurns: 0, memoryChars: memory.length }
  }
}
