/**
 * The DREAM-CYCLE -- the strong periodic re-grounding of the rolling `<memory>`
 * (plan-dispatcher-living-history.md §5, "the bard + editor"; Jonas's B9).
 *
 * The live fold (consolidate.ts, Haiku) folds aged TURNS into `<memory>` cheaply,
 * many times. But a pure incremental scribe DRIFTS: each fold accrues a little
 * duplication, a little stale state, the occasional contradiction. The dream-cycle
 * is the EDITOR pass: infrequent, stronger model (Opus), it takes the accumulated
 * memory and rewrites it into the tightest faithful version -- merge duplicates,
 * supersede stale/contradictory facts at the FACT level (keep the latest, not a
 * blind prose overwrite), drop the no-longer-relevant, keep the durable.
 *
 * Operates ONLY on the memory block (not turns) -- it tidies what the scribe wrote,
 * it does not fold new dialogue. Pure-ish: the LLM call is injected; on any failure
 * the existing memory is kept untouched (no regression, no loss).
 */

import type { ChatFn } from './classify'
import { MAX_MEMORY_CHARS, MEMORY_BLOCK_ID } from './consolidate'
import { type LivingHistory, upsertBlock } from './living-history'

/** The dream-cycle's model. Opus by design -- this is the rare, high-quality pass
 *  (the editor), as opposed to the cheap Haiku live fold (the scribe). */
const DREAM_MODEL = 'anthropic/claude-opus-4.8'

/** Below this many chars there is nothing worth an Opus re-ground -- skip (no cost). */
export const DREAM_MIN_MEMORY_CHARS = 200

const SYSTEM = [
  "You are RE-GROUNDING a dispatcher's long-term MEMORY about its user and their",
  'fleet of dev projects. This memory was built by MANY cheap incremental folds, so',
  'it may have drifted: duplicated facts, stale state, or contradictions where a',
  'later fact should have replaced an earlier one. Rewrite it into the TIGHTEST',
  'faithful version. Rules:',
  '- MERGE duplicates and near-duplicates into one crisp line.',
  '- SUPERSEDE at the fact level: when two lines conflict, keep the most recent /',
  '  most specific and drop the outdated one. Do NOT keep both.',
  '- DROP stale or no-longer-relevant facts (resolved questions, finished one-offs).',
  '- KEEP durable substance: standing preferences, ongoing threads, decisions made,',
  '  open questions, which projects/topics the user cares about.',
  '- Do NOT INVENT. Add nothing that is not already present -- this is a clean-up, not',
  '  a new summary. If the memory is already tight, return it essentially unchanged.',
  `- Output PLAIN markdown bullets, under ${MAX_MEMORY_CHARS} characters, NO preamble,`,
  '  NO "Memory:" header. Just the content.',
].join('\n')

export interface DreamResult {
  /** True iff the re-ground ran AND succeeded (memory rewritten in place). */
  ran: boolean
  beforeChars: number
  afterChars: number
  usage?: Awaited<ReturnType<ChatFn>>['usage']
  model?: string
}

function cap(text: string, max: number): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max).trimEnd()}…` : t
}

/**
 * Re-ground the rolling `<memory>` block with the stronger model. No-op (no LLM
 * call) when the memory is too short to be worth it or absent. On LLM failure the
 * existing memory is left untouched.
 */
export async function dreamCycle(
  history: LivingHistory,
  now: number,
  chat: ChatFn,
  model: string = DREAM_MODEL,
): Promise<DreamResult> {
  const memory = history.blocks.get(MEMORY_BLOCK_ID)?.content ?? ''
  if (memory.trim().length < DREAM_MIN_MEMORY_CHARS) {
    return { ran: false, beforeChars: memory.length, afterChars: memory.length }
  }
  try {
    const res = await chat({
      model,
      system: SYSTEM,
      user: memory,
      maxTokens: 900,
      temperature: 0,
      timeoutMs: 40_000,
      timeoutRetries: 0,
    })
    const next = cap(res.content, MAX_MEMORY_CHARS)
    if (next) upsertBlock(history, MEMORY_BLOCK_ID, 'memory', next, now)
    return { ran: true, beforeChars: memory.length, afterChars: next.length, usage: res.usage, model: res.model }
  } catch {
    return { ran: false, beforeChars: memory.length, afterChars: memory.length }
  }
}
