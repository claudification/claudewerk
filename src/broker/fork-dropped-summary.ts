/**
 * Summarize the slice a point-in-time fork is about to THROW AWAY.
 *
 * The high-value shape is a carry-AFTER fork of an exhausted session: keep the
 * last N turns verbatim, and let one paragraph stand in for the several hundred
 * before them. Without this the fork starts mid-sentence with no idea how it got
 * there; with it the recent work is intact and the ancient history is one
 * readable block.
 *
 * ## Why this runs in the broker and not the sentinel
 *
 * The sentinel has host filesystem access, not a model client, and the broker
 * already holds every transcript entry in SQLite. So the broker slices its OWN
 * copy at the same boundary (`sliceAtCut`, shared with the sentinel's fold) and
 * ships the finished text down inside `provenanceBlock`, which already lands at
 * the very top of the fold's preamble. Nothing new crosses the wire.
 *
 * ## Why carry-BEFORE never summarizes
 *
 * There the discarded slice is the FUTURE -- the turns you are forking back past
 * in order to redo them differently. Pasting them into the preamble would hand
 * the fork the very answer it exists to reconsider.
 */

import { type CutAccessors, sliceAtCut, toEpochMs } from '../shared/fork-cut'
import type { ForkPoint, TranscriptEntry } from '../shared/protocol'
import { renderTurns } from './fork-summary'
import { chat } from './recap/shared/openrouter-client'

/** Fast and cheap on purpose: this is a scene-setter, not the fork's payload. */
export const DROPPED_SUMMARY_MODEL = 'anthropic/claude-haiku-4.5'
const DROPPED_SUMMARY_MAX_TOKENS = 1200
/** Below this the dropped slice is cheaper to carry verbatim than to summarize. */
export const DROPPED_SUMMARY_MIN_ENTRIES = 8

const SYSTEM_PROMPT = `You are compressing the EARLY part of a software engineering session into one
briefing. The recent turns are being kept verbatim and the reader will see them
directly after your text -- yours covers only what came BEFORE.

Write a single tight block covering, in this order, skipping anything absent:
GOAL the user stated, WHAT WAS DONE and verified, DECISIONS made and why, FILES
that matter, and DEAD ENDS already ruled out.

Rules:
- Preserve verbatim any standing user instruction, constraint or naming convention.
- Prefer specifics. "Renamed listCcSessions to include dots in the slug" beats
  "addressed a path issue".
- Do not invent progress, and do not describe what happens next -- the reader can
  see that part.
- No preamble, no sign-off. Output the briefing only.`

const ENTRY_ACCESSORS: CutAccessors<TranscriptEntry> = {
  uuidOf: e => e.uuid,
  timeOf: e => toEpochMs(e.timestamp),
}

export interface DroppedSummaryInput {
  entries: TranscriptEntry[]
  forkPoint: ForkPoint
  /** Injectable for tests. */
  chatFn?: typeof chat
}

/**
 * The summary stands in for real history, so it says so. An unlabelled paragraph
 * at the top of a transcript reads as something the agent itself concluded.
 */
function renderDroppedSummary(summary: string, droppedTurns: number): string {
  return [`[earlier context -- ${droppedTurns} turns, summarized rather than carried verbatim]`, '', summary].join('\n')
}

/**
 * Returns the provenance text to append, or undefined when there is nothing worth
 * summarizing. Never throws: a failed summary degrades the fork's preamble, it
 * does not fail the fork.
 */
export async function summarizeDroppedSlice(input: DroppedSummaryInput): Promise<string | undefined> {
  const { forkPoint } = input
  if (!forkPoint.summarizeDropped || forkPoint.direction !== 'after') return undefined

  const { dropped, resolvedBy } = sliceAtCut(input.entries, forkPoint, ENTRY_ACCESSORS)
  if (resolvedBy === 'none' || dropped.length < DROPPED_SUMMARY_MIN_ENTRIES) return undefined

  const body = renderTurns(dropped)
  if (!body.trim()) return undefined

  try {
    const res = await (input.chatFn ?? chat)({
      model: DROPPED_SUMMARY_MODEL,
      feature: 'fork-dropped-summary',
      system: SYSTEM_PROMPT,
      user: body,
      maxTokens: DROPPED_SUMMARY_MAX_TOKENS,
      temperature: 0.1,
    })
    const summary = res.content?.trim()
    return summary ? renderDroppedSummary(summary, dropped.length) : undefined
  } catch {
    // A fork that lost its scene-setter is still a working fork.
    return undefined
  }
}
