/**
 * THE conversation-intent prompt -- one call, every naming field.
 *
 * Replaces three prompts that answered overlapping questions and could disagree
 * with each other: `AWAY_SUMMARY_PROMPT` (title/recap/name), the per-turn
 * classifier (`currently`), and quick recap's short description. One call, one
 * answer, paid for once.
 *
 * The calibration below is lifted from Claude Code's own tool-summary prompt,
 * because it is the single most useful line in that binary:
 *
 *   "It appears as a single-line row in a mobile app and truncates around 30
 *    characters, so think git-commit-subject, not sentence."
 *
 * A render constraint plus a genre does more work than any word budget. Every
 * field below states where it appears and what it should read like, instead of
 * just how long it may be.
 */

import type { IntentContext } from '../../shared/transcript-intent-context'

/** What one classify call returns. Every field is independently useful; a
 *  caller may take only `name` (the renamer) or only `intent` (the fleet row). */
export interface ConversationIntent {
  /** The renamer's output: short, lowercase, 2-4 words. */
  name: string
  /** A topic label for headers and lists. 3-6 words. */
  title: string
  /** Quick recap: one sentence on what is happening and where it stands. */
  description: string
  /** Present tense: what it is doing RIGHT NOW. Empty when nothing has started. */
  intent: string
}

export const INTENT_MODEL = 'anthropic/claude-haiku-4.5'
export const INTENT_MAX_TOKENS = 300
export const INTENT_TEMPERATURE = 0.1

const SHARED_RULES = `Reply with ONLY a JSON object: {"name":"...","title":"...","description":"...","intent":"..."}

name: the conversation's handle in a sidebar. Lowercase, 2-4 words, letters/digits/spaces only.
  Prefix "bug: ", "feat: " or "chore: " only when the session is clearly one of those.
  Examples: "spawn timeout fix", "bug: invalid name", "feat: recap names", "internet research".
title: a topic label for a header. 3-6 words, sentence case, no trailing period.
  Examples: "Fix spawn timeout", "SQLite migration", "Naming benchmark".
description: ONE sentence, under 20 words, on what is being done and where it stands.
  No "I" or "we". No labels like "Goal:" or "Next:". No markdown, no bullets, no backticks.
intent: what the agent is doing RIGHT NOW, present participle, under 30 characters.
  This renders as a single-line row and truncates around 30 characters, so think
  git-commit-subject, not sentence. Name the artifact when you can:
  "wiring swipe into app shell" beats "working on the frontend".`

/**
 * NEW conversation: one user message, nothing has happened yet.
 *
 * The failure mode here is PADDING -- a model asked to describe progress will
 * invent some. So it is told plainly that there is none, and `intent` is
 * allowed to be empty rather than fabricated.
 */
const NEW_SYSTEM = `You name a coding session that has JUST been opened. The user has made a request
and no work has happened yet.

Describe what was ASKED FOR. Do not describe progress, results, or findings --
there are none, and inventing them is worse than saying nothing.
Set "intent" to "" (empty) unless the request itself names an action already underway.

${SHARED_RULES}`

/**
 * LONG-RUNNING conversation. Two distinct failure modes, both addressed
 * explicitly because a general "summarize this" prompt falls into both:
 *
 *   TAIL BIAS -- the last messages are usually follow-ups ("thanks", "commit
 *   that", "yes"), and summarizing the tail reports the follow-up as the topic.
 *
 *   MISSION STALENESS -- CC's own capturedIntent freezes the FIRST message
 *   forever, so a session that changed direction keeps its original label. The
 *   fix is time decay: later user messages may supersede the initial request.
 */
const LONG_SYSTEM = `You name a coding session that has been running for a while.

Capture the session's MAIN TASK, not the latest exchange. When the most recent
messages are short follow-ups (commit confirmations, acknowledgements, "done",
"thanks", "go"), describe the substantial work they conclude -- never the
follow-up itself.

BACKGROUND, when present, is what earlier recaps of this same session already
concluded -- prior context, not new work.
INITIAL REQUEST is what the session was opened for. USER INPUTS SINCE are newer
and may SUPERSEDE it: if a later message clearly redirects the work, follow the
redirect and name the session for where it is now, not where it started.
RESULTS SO FAR is what has actually happened; ground the description in it.

${SHARED_RULES}`

export function intentSystemPrompt(shape: 'new' | 'long'): string {
  return shape === 'new' ? NEW_SYSTEM : LONG_SYSTEM
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s)

/**
 * Render the context into the three explicit slots the prompts refer to.
 *
 * Slots rather than one blob on purpose: the model has to be able to tell the
 * opening ask apart from a later redirect apart from what actually happened,
 * and it cannot do that if they arrive as undifferentiated text.
 */
export function intentUserPrompt(ctx: IntentContext): string {
  const [first, ...rest] = ctx.userMessages
  const parts: string[] = []

  if (first) parts.push(`INITIAL REQUEST:\n${clip(first.text, 1200)}`)

  if (rest.length) {
    // Newest first: a redirect is more likely in the last thing said, and this
    // ordering survives truncation with the decisive message intact.
    const since = [...rest]
      .reverse()
      .slice(0, 8)
      .map(m => `- ${clip(m.text, 400)}`)
      .join('\n')
    parts.push(`USER INPUTS SINCE (newest first):\n${since}`)
  }

  if (ctx.background?.trim()) {
    parts.push(`BACKGROUND (earlier recaps of this same session):\n${clip(ctx.background.trim(), 800)}`)
  }

  if (ctx.activity.length) {
    parts.push(`RESULTS SO FAR:\n${ctx.activity.map(a => `- ${clip(a, 200)}`).join('\n')}`)
  } else {
    parts.push('RESULTS SO FAR:\n(nothing yet -- no work has started)')
  }

  return parts.join('\n\n')
}
