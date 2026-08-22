/**
 * A VERDICT THAT IS NOT ON THE CARD WAS NOT DELIVERED.
 *
 * THE 2026-08-22 FAILURE: the werk-verifier for `werk-rename-seats` did the whole
 * job -- scratch worktree, every command re-run, four commits and 224 files read,
 * APPROVED -- and then could not write that judgement anywhere a reader would
 * find it. The card settled at `done` carrying no verdict section and no evidence
 * keys, which from the board alone is indistinguishable from a card nobody ever
 * reviewed. The next werk-master generation found the approval only by guessing
 * the verifier's conversation id and reading its transcript tail.
 *
 * So the verdict stops being prose an agent is ASKED to write and becomes a
 * PARAMETER of the move that closes the review. This module is the pure half:
 * which moves carry a verdict, what the section looks like, and how it lands on a
 * body that may already carry one. The write itself (and the refusal when it
 * fails) lives at the tool boundary -- `card-verdict-write.ts`.
 *
 * ONE SECTION, REWRITTEN, never appended twice: a card bounced and re-reviewed
 * three times would otherwise grow three verdicts and a reader would have to
 * work out which one is current. The heading is `## Verdict` and it is matched
 * literally, so a hand-written one from before this shipped is UPGRADED in place
 * rather than duplicated.
 */

import type { TaskStatus } from './task-statuses'

export type VerdictDecision = 'APPROVED' | 'BOUNCED'

/** The heading the section owns. Matched literally on rewrite. */
export const VERDICT_HEADING = '## Verdict'

/** Lanes a bounce sends a card back to. `archived` is a DROP, not a verdict:
 *  the werk-master retires cards that way and it reviews nothing doing it. */
const BOUNCE_TARGETS: readonly TaskStatus[] = ['in-progress', 'open']

/**
 * Which verdict a lane move DELIVERS, or null when the move carries none.
 *
 * Keyed on leaving `in-review`, because that lane means exactly one thing: a
 * verifier is deciding. Every other move on the board -- a worker taking a card
 * to `in-progress`, a planner filing to `open`, the werk-master archiving --
 * settles no review and must stay ungated, or the board seizes up.
 */
export function verdictDecisionFor(from: TaskStatus, to: TaskStatus): VerdictDecision | null {
  if (from !== 'in-review') return null
  if (to === 'done') return 'APPROVED'
  return BOUNCE_TARGETS.includes(to) ? 'BOUNCED' : null
}

export interface VerdictInput {
  decision: VerdictDecision
  /** The acting conversation id. MACHINE-supplied at the tool boundary, never
   *  agent text -- the same rule the gate's evidence keys follow. */
  by: string
  /** ISO timestamp, injected for the same reason. */
  at: string
  /** The verdict in the verifier's own words: what it ran, what it saw. */
  summary: string
  /** Works, but watch X. Harvested from the seat's own `set_status` when it
   *  reports one after the move (see `verdict-harvest.ts`). */
  caveats?: string
  /** FYI asides that are true even though the card is settled. Same harvest. */
  notes?: string
}

function labelled(label: string, value: string | undefined): string[] {
  const v = value?.trim()
  return v ? ['', `**${label}:** ${v}`] : []
}

/**
 * Render the section. The attribution line is first and machine-authored, so a
 * reader can tell an approval from a bounce without reading the prose, and can
 * tell WHICH conversation said it without guessing at a transcript.
 */
export function renderVerdictSection(v: VerdictInput): string {
  return [
    VERDICT_HEADING,
    '',
    `**${v.decision}** by \`${v.by}\` at ${v.at}`,
    '',
    v.summary.trim(),
    ...labelled('Caveats', v.caveats),
    ...labelled('Notes', v.notes),
  ].join('\n')
}

/** Does this body already carry a verdict section? */
export function hasVerdictSection(body: string): boolean {
  return sectionBounds(body) !== null
}

/** Start/end offsets of the existing section, or null when there is none. */
function sectionBounds(body: string): { start: number; end: number } | null {
  const start = findHeading(body)
  if (start === -1) return null
  // The section runs to the next `## `-or-shallower heading, or to the end.
  const rest = body.slice(start + VERDICT_HEADING.length)
  const next = rest.search(/\n#{1,2} /)
  return { start, end: next === -1 ? body.length : start + VERDICT_HEADING.length + next + 1 }
}

function findHeading(body: string): number {
  if (body.startsWith(`${VERDICT_HEADING}\n`) || body.trimEnd() === VERDICT_HEADING) return 0
  const at = body.indexOf(`\n${VERDICT_HEADING}\n`)
  return at === -1 ? -1 : at + 1
}

/**
 * Put `section` on the body, replacing any verdict already there.
 *
 * Everything else on the card is untouched -- a bounce's `## Guard Findings`,
 * the worker's `## Built`, the card's own spec. The section lands at the END on
 * a first write, which is where a reader looks for the outcome of a card they
 * have just finished reading.
 */
export function upsertVerdictSection(body: string, section: string): string {
  const block = section.trimEnd()
  const bounds = sectionBounds(body)
  const head = body.trimEnd()
  const out = bounds
    ? `${body.slice(0, bounds.start)}${block}\n\n${body.slice(bounds.end)}`
    : head
      ? `${head}\n\n${block}`
      : block
  return `${out.trimEnd()}\n`
}
