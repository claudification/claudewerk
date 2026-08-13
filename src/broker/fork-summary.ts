/**
 * Fork mode C -- a written continuation summary instead of a folded transcript.
 *
 * Unlike the other two modes this needs no sentinel and no transcript file: the
 * broker already holds the conversation's entries in SQLite. It summarizes them
 * and the fork launches as a FRESH CC session seeded with that text.
 *
 * Worth being honest about the trade: once `digestLargeToolResults` lands, the
 * condensed fork is smaller for FREE and keeps the real tool history. What
 * a summary buys instead is a short, readable handoff a human can check -- and
 * a fork that carries none of the original's dead ends. It costs one model call
 * and is the lossiest of the three.
 *
 * The instruction deliberately mirrors the shape Claude Code uses for its own
 * continuation summaries, so a resumed agent reads something familiar.
 */

import { renderForkProvenance } from '../shared/fork-provenance'
import type { TranscriptEntry } from '../shared/protocol'
import { chat } from './recap/shared/openrouter-client'
import { extractUserPromptsAndFinals } from './recap/shared/transcript-extract'

export const FORK_SUMMARY_MODEL = 'anthropic/claude-opus-4.8'
export const FORK_SUMMARY_MAX_TOKENS = 4000
/** Turns fed to the summarizer. Enough for a long session, bounded for cost. */
export const FORK_SUMMARY_MAX_TURNS = 400

const SYSTEM_PROMPT = `You are writing a continuation summary for a software engineering session.

The summary REPLACES the conversation history for a future context window: another
instance of the agent will read only your summary and must be able to pick the work
up without re-reading anything. Be structured, concise and actionable.

Cover, in this order, omitting any section that genuinely has no content:

1. GOAL -- what the user actually asked for, in their terms.
2. STATE -- what is done and verified, what is in progress, what is untouched.
3. DECISIONS -- choices made and WHY, especially ones that would otherwise be
   re-litigated or accidentally reversed.
4. FILES -- concrete paths touched or that matter, each with one line on its role.
5. GOTCHAS -- failures hit, dead ends already ruled out, constraints discovered.
6. NEXT -- the immediate next step, specific enough to act on directly.

Rules:
- Preserve verbatim anything that must survive to keep applying: explicit user
  instructions, standing constraints, naming conventions, commands that work.
- Prefer specifics over summary-speak. "Fixed the slug in listCcSessions to
  include dots" beats "addressed a path issue".
- Do not invent progress. If something was attempted and failed, say so.
- No preamble and no sign-off. Output the summary only.`

export interface ForkSummaryInput {
  entries: TranscriptEntry[]
  /** Display name of the source conversation, for context. */
  conversationTitle?: string
  /** Injectable for tests. */
  chatFn?: typeof chat
}

export type ForkSummaryOutcome = { ok: true; summary: string } | { ok: false; error: string }

/**
 * Render the transcript into the turn-by-turn text the summarizer reads.
 *
 * `includeInternals` pulls in per-turn tool calls and tool errors. That matters
 * here more than it does for a recap: the GOTCHAS and FILES sections are mostly
 * derivable from what was actually run and what failed, not from the prose.
 */
export function renderTurns(entries: TranscriptEntry[]): string {
  const turns = extractUserPromptsAndFinals(entries, { includeInternals: true })
  // Keep the most RECENT turns when over budget -- the tail is what the
  // continuation needs; the early turns are the parts already settled.
  return turns
    .slice(-FORK_SUMMARY_MAX_TURNS)
    .map(t =>
      [
        t.userPrompt && `USER: ${t.userPrompt}`,
        t.internals && `[tools] ${t.internals}`,
        t.assistantFinal && `ASSISTANT: ${t.assistantFinal}`,
      ]
        .filter(Boolean)
        .join('\n'),
    )
    .filter(Boolean)
    .join('\n\n')
}

export async function generateForkSummary(input: ForkSummaryInput): Promise<ForkSummaryOutcome> {
  const body = renderTurns(input.entries)
  if (!body.trim()) {
    // An empty transcript would produce a confidently invented summary, which is
    // worse than refusing: the fork would start from fiction.
    return { ok: false, error: 'Nothing to summarize -- this conversation has no transcript yet' }
  }

  const header = input.conversationTitle ? `Session: ${input.conversationTitle}\n\n` : ''
  try {
    const res = await (input.chatFn ?? chat)({
      model: FORK_SUMMARY_MODEL,
      feature: 'fork-summary',
      system: SYSTEM_PROMPT,
      user: `${header}${body}`,
      maxTokens: FORK_SUMMARY_MAX_TOKENS,
      temperature: 0.1,
    })
    const summary = res.content?.trim()
    if (!summary) return { ok: false, error: 'Summarizer returned nothing' }
    return { ok: true, summary }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

/**
 * The seed text the forked session starts from. Framed as inherited context
 * rather than as an instruction, so the agent does not read the summary's
 * "NEXT" section as a command to start executing before the user has spoken.
 *
 * The provenance block leads, because this is the lossiest mode: the summary is
 * ALL the agent gets, so knowing a full record exists -- and how to read it --
 * matters more here than anywhere else.
 */
export function buildForkSeedPrompt(summary: string, source: { conversationId: string; title?: string }): string {
  const from = source.title ? ` of "${source.title}"` : ''
  return [
    renderForkProvenance({
      conversationId: source.conversationId,
      conversationName: source.title,
      mode: 'summarized',
    }),
    '',
    `This session is a continuation${from}. The conversation history has been replaced`,
    'by the summary below. Treat it as context you already have, not as a new instruction --',
    'wait for the user before acting on it.',
    '',
    '--- INHERITED CONTEXT ---',
    summary,
  ].join('\n')
}
