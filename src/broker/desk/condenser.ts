/**
 * The Haiku CONDENSER for per-project memory (plan-dispatcher-brain.md P3).
 *
 * The event hooks (P2) append raw, transient signal; this folds it into the
 * durable, SMALL per-project brief. It is the summary-keeper / mini dream-cycle
 * (Front Desk D7/D8) made minimal: given the current brief + new raw events
 * (+ recap excerpts on cold start), it rewrites a brief that keeps DURABLE
 * facts, supersedes stale state, and DROPS transient noise ("a turn ended",
 * "25 idle conversations"). Cheap model, bounded output.
 *
 * Pure + injectable (ChatFn) -- unit-tested without network. On any LLM failure
 * the caller keeps the existing brief (memory never regresses to empty).
 */

import type { ChatFn } from './classify'
import type { RawEvent } from './project-memory'

export const CONDENSE_MODEL = 'anthropic/claude-haiku-4.5'
/** The brief must fit in the system prompt every turn -- keep it tiny. */
export const MAX_BRIEF_CHARS = 1200

const SYSTEM = [
  'You maintain a TINY durable BRIEF for ONE software project in a dev fleet --',
  'the front desk reads it to know what this project is about and where it stands.',
  'You are given the CURRENT brief plus NEW raw signal since the last update.',
  'Rewrite the brief, integrating the new signal. Rules:',
  '- Keep DURABLE facts: what the project is, its current goals/workstreams, key',
  '  topics + entities, and where things STAND right now.',
  '- DROP transient noise: individual turns ending, idle counts, per-conversation',
  '  churn, raw status flips. Never write "N idle conversations" or "a turn ended".',
  '- SUPERSEDE outdated state -- replace, do not append. The brief must not grow.',
  '- If the new signal adds nothing durable, return the current brief unchanged.',
  `- Output PLAIN markdown prose/bullets, under ${MAX_BRIEF_CHARS} characters, NO`,
  '  preamble, NO headers like "Brief:". Just the content.',
].join('\n')

export interface CondenseInput {
  label: string
  projectUri: string
  currentBrief: string
  events: RawEvent[]
  /** Recap excerpts for cold-start backfill (D51) -- already-condensed memory. */
  recapExcerpts?: string[]
}

function buildUser(input: CondenseInput): string {
  const parts: string[] = [`PROJECT: ${input.label} (${input.projectUri})`]
  parts.push(input.currentBrief ? `CURRENT BRIEF:\n${input.currentBrief}` : 'CURRENT BRIEF: (none yet)')
  if (input.recapExcerpts?.length) {
    parts.push(`RECENT RECAPS (seed context):\n${input.recapExcerpts.map(r => `- ${r}`).join('\n')}`)
  }
  if (input.events.length) {
    parts.push(`NEW SIGNAL since last update:\n${input.events.map(e => `- ${e.summary}`).join('\n')}`)
  }
  return parts.join('\n\n')
}

/** Fold new signal into the project brief. Returns the new (capped) brief, or
 *  the current brief if the model fails / returns nothing useful. */
export async function condenseBrief(input: CondenseInput, chat: ChatFn): Promise<string> {
  try {
    const res = await chat({
      feature: 'desk-condenser',
      model: CONDENSE_MODEL,
      system: SYSTEM,
      user: buildUser(input),
      maxTokens: 600,
      temperature: 0,
      timeoutMs: 20_000,
      timeoutRetries: 0,
    })
    const next = res.content.trim()
    if (!next) return input.currentBrief
    return next.length > MAX_BRIEF_CHARS ? `${next.slice(0, MAX_BRIEF_CHARS).trimEnd()}…` : next
  } catch {
    return input.currentBrief
  }
}
