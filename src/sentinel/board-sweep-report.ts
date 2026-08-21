/**
 * THE BREW -- rendering one sweep as the dated markdown artifact at
 * `.rclaude/project/reports/<date>.md`.
 *
 * Tier 2 of D7's three tiers of record: greppable, one line of reason per item,
 * and it outlives the event-log DB's 30-day purge. It is a STRING FUNCTION --
 * no filesystem, no clock -- so every shape below (a full brew, an empty one, a
 * short-circuited one) is exercised without a board beside it.
 *
 * WHY THE REFUSALS ARE IN THE FILE. A report that lists only what it proposes
 * cannot be told apart from a report that failed to look. The bucket census at
 * the bottom is the denominator: `12 candidates considered, 3 proposals` reads
 * as a working sweep, `0 candidates` reads as a broken one, and both look
 * identical if you print proposals alone.
 */

import type { Proposal } from '../shared/board-sweep-proposals'
import { PROPOSAL_KINDS } from '../shared/board-sweep-proposals'
import { wallClockParts } from '../shared/cron-time'
import type { BoardSweepRefusal } from '../shared/protocol'

/** A heading per kind, in the order `PROPOSAL_KINDS` declares them. */
const KIND_HEADING: Readonly<Record<string, string>> = {
  'promote-delivered': 'Delivered -- promote to `done`',
  'archive-cold': 'Cold in `inbox` -- archive',
  'flag-duplicate': 'Possible duplicates -- your call',
  'note-delete-at': '`delete_at` elapsed -- FOR A HUMAN, never executed here',
}

function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

/**
 * `YYYY-MM-DD` for an instant, projected into `tz`.
 *
 * NEVER `toISOString().slice(0,10)`: the broker container is UTC, so a 00:30
 * Europe/Berlin sweep would file itself under yesterday and a "morning report"
 * would arrive with the wrong name on it roughly a third of the world's zones.
 */
export function reportDateIn(nowMs: number, tz: string): string {
  const wc = wallClockParts(nowMs, tz)
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.day)}`
}

/** `YYYY-MM-DD HH:MM` in `tz`, for the stamp under the title. Nothing here ever
 *  renders a bare time -- the zone is printed beside it, always. */
function stampIn(nowMs: number, tz: string): string {
  const wc = wallClockParts(nowMs, tz)
  return `${wc.year}-${pad2(wc.month)}-${pad2(wc.day)} ${pad2(wc.hour)}:${pad2(wc.minute)} ${tz}`
}

function proposalLine(p: Proposal): string {
  const box = p.checked ? '[x]' : '[ ]'
  return `- ${box} \`${p.card}\` -- ${p.detail}`
}

/** Refusals folded into `bucket: n` counts, ordered by count then name so two
 *  consecutive reports diff cleanly for a human reading them side by side. */
function bucketCensus(refused: readonly BoardSweepRefusal[]): string[] {
  const counts = new Map<string, number>()
  for (const r of refused) counts.set(r.bucket, (counts.get(r.bucket) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([bucket, n]) => `| \`${bucket}\` | ${n} |`)
}

export interface BoardReportInput {
  project: string
  date: string
  nowMs: number
  tz: string
  proposals: readonly Proposal[]
  selected: readonly string[]
  acted: readonly string[]
  refused: readonly BoardSweepRefusal[]
  snapshot: string
  skipped: boolean
  idleReason?: string
  /** True when no duplicate judge was injected -- said out loud rather than
   *  left to look like "no duplicates were found". */
  duplicateJudgeAbsent: boolean
}

function proposalSections(proposals: readonly Proposal[]): string[] {
  const lines: string[] = []
  for (const kind of PROPOSAL_KINDS) {
    const rows = proposals.filter(p => p.kind === kind)
    if (rows.length === 0) continue
    lines.push('', `## ${KIND_HEADING[kind] ?? kind} (${rows.length})`, '')
    lines.push(...rows.map(proposalLine))
  }
  return lines
}

/** The whole artifact. Deterministic given its input -- the fold already sorted
 *  the proposals, and this adds no clock of its own beyond the stamp it is given. */
export function renderBoardReport(input: BoardReportInput): string {
  const lines: string[] = [
    `# Morning report -- ${input.date}`,
    '',
    `Swept ${stampIn(input.nowMs, input.tz)} against \`${input.project}\`.`,
    `Board snapshot \`${input.snapshot}\`.`,
  ]

  if (input.skipped) {
    lines.push(
      '',
      '## Nothing moved',
      '',
      `${input.idleReason ?? 'HEAD and the board are unchanged since the last sweep'} -- ` +
        'the fold short-circuited and computed nothing. This is the cheap path, not a failure.',
    )
    return `${lines.join('\n')}\n`
  }

  if (input.proposals.length === 0) {
    lines.push('', '## No proposals', '', input.idleReason ?? 'nothing on the board earned a proposal.')
  } else {
    lines.push(...proposalSections(input.proposals))
  }

  lines.push(
    '',
    '## What was looked at',
    '',
    `${input.selected.length} candidate card(s) considered, ${input.acted.length} earned a proposal.`,
    '',
    '| Refused into | Cards |',
    '|---|---|',
    ...bucketCensus(input.refused),
  )

  if (input.duplicateJudgeAbsent) {
    lines.push(
      '',
      '> **The duplicate pass did not run.** No judge is wired into the sweep, so ' +
        '`flag-duplicate` is ABSENT rather than empty -- nobody looked, which is not the ' +
        'same claim as "there are none".',
    )
  }

  lines.push(
    '',
    '---',
    '',
    '`note-delete-at` rows are a MARKER for a human (F18). Nothing in this pipeline ' +
      'hard-deletes a card, and the `apply` op refuses that kind outright.',
  )
  return `${lines.join('\n')}\n`
}
