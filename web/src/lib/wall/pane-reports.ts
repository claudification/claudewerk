/**
 * THE REPORT BUILDERS for the six panes that are a LIST OF EVENTS -- P1 pulse,
 * A1 blocked-on-you, P2 commits, P3 card moves, A8 pinned epics, A7 unattended
 * runs. The six that are a set of READINGS live in `stat-reports.ts`.
 *
 * Every builder is PURE and takes the rows the pane already rendered from, so a
 * report is testable without a DOM and can never disagree with the pane: there
 * is no second query, no second sort, and nothing here reads the clock.
 *
 * A REPORT SAYS WHAT THE PANE COULD NOT FIT, and no more. The row on screen
 * truncates a commit subject and drops a conversation's cost; the report carries
 * both. What it must NOT do is invent a fact the pane never had -- A7 is the one
 * with teeth, and its docstring says exactly which numbers it refuses to print.
 */

import type { PulseFleet, PulseRow } from '@/components/pulse/use-pulse-fleet'
import type { AttentionEntry } from '@/components/wall/attention-entries'
import { rowTitle, runSections, type TailRow } from '@/components/wall/runs/run-liveness'
import { runView } from '@/components/wall/runs/run-model'
import type { UnattendedRow } from '@/components/wall/runs/use-unattended-runs'
import type { WallPinRow } from '@/components/wall/use-wall-pins'
import { pulseAge } from '@/lib/pulse/action-text'
import type { LedgerRow } from './card-ledger'
import type { RiverRow } from './commit-river'
import { reportChild, reportMore, reportParens, reportRow, reportUsd, type WallReportView, wallReport } from './report'

// ---------------------------------------------------------------------------
// P1 PULSE
// ---------------------------------------------------------------------------

/**
 * ONE PULSE ROW, as its own copy button yields it.
 *
 * The row on screen drops model, host, cost and context pressure to fit a 407px
 * column and truncates the action line; all five come back here. This is the
 * same set `pulseHoverFacts` shows on hover -- one row, one set of facts it was
 * too narrow to say.
 */
export function pulseRowValue(row: PulseRow): string {
  return reportRow(
    `[${row.band}]`,
    row.project,
    row.title,
    `-- ${row.action}`,
    reportParens(
      pulseAge(row.ageMs),
      row.costUsd === undefined ? null : reportUsd(row.costUsd),
      row.contextPct === undefined ? null : `ctx ${Math.round(row.contextPct)}%`,
      row.host,
      row.model,
      row.managedBy?.label,
    ),
  )
}

export function pulseReport(fleet: PulseFleet, view: WallReportView): string {
  return wallReport({
    title: 'PULSE',
    code: 'P1',
    ...view,
    lines: [
      ...fleet.flat.map(pulseRowValue),
      // Both silences, told apart in the paste exactly as the pane tells them
      // apart on screen: one is what you typed, the other is a default you never
      // chose. A report that merged them would read as an over-tight filter.
      reportMore(fleet.hidden, 'hidden by the filter'),
      reportMore(fleet.managedHidden, 'machine-run hidden -- +over to show'),
    ],
    empty: 'nothing matches',
  })
}

// ---------------------------------------------------------------------------
// A1 BLOCKED ON YOU
// ---------------------------------------------------------------------------

/**
 * ONE WAITING QUESTION -- what the row's own copy button yields.
 *
 * The QUESTION is the payload, and it goes on its own line: this is the value
 * you paste into a message asking someone what to answer, and a question
 * squashed onto the end of a metadata line is the one that gets skimmed past.
 * `waitedMs` is passed in because the caller owns the ticking clock; a builder
 * that read `Date.now()` could not be asked what it said at any other moment.
 */
export function attentionRowValue(entry: AttentionEntry, waitedMs: number): string {
  const head = reportRow(
    entry.tier === 'hard' ? 'HARD' : 'soft',
    entry.project,
    entry.title,
    `waiting ${pulseAge(waitedMs)}`,
  )
  return [head, reportChild(`Q: ${entry.question}`), entry.detail ? reportChild(entry.detail) : null]
    .filter(Boolean)
    .join('\n')
}

export function attentionReport(rows: readonly AttentionEntry[], now: number, view: WallReportView): string {
  return wallReport({
    title: 'BLOCKED ON YOU',
    code: 'A1',
    ...view,
    lines: rows.map(entry => attentionRowValue(entry, Math.max(0, now - entry.since))),
    empty: 'nobody is waiting on you',
  })
}

// ---------------------------------------------------------------------------
// P2 COMMIT RIVER
// ---------------------------------------------------------------------------

/**
 * THE FULL SHA, never the seven characters on screen. A copied hash you have to
 * re-expand is a copy button that wasted your time -- and the row's own button
 * yields the bare hash rather than this line, because "copy the sha" means the
 * sha. This is the RIVER line, for the pane report.
 */
export function commitRowValue(row: RiverRow): string {
  return reportRow(
    row.hash,
    row.projectName,
    row.subject,
    reportParens(
      `+${row.insertions}/-${row.deletions}`,
      row.branch,
      row.age,
      row.hasConversation ? (row.conversationName ?? 'a conversation') : 'terminal',
    ),
  )
}

export function commitRiverReport(rows: readonly RiverRow[], view: WallReportView): string {
  return wallReport({
    title: 'COMMIT RIVER',
    code: 'P2',
    ...view,
    lines: rows.map(commitRowValue),
    empty: 'no commit in the ledger',
  })
}

// ---------------------------------------------------------------------------
// P3 CARD LEDGER
// ---------------------------------------------------------------------------

export function cardLedgerReport(rows: readonly LedgerRow[], view: WallReportView): string {
  return wallReport({
    title: 'CARD LEDGER',
    code: 'P3',
    ...view,
    lines: rows.map(row =>
      reportRow(
        row.id,
        `${row.from} -> ${row.to}`,
        row.priority ? `[${row.priority}]` : null,
        row.title,
        `(${row.projectName}, ${row.age})`,
      ),
    ),
    empty: 'no card has moved yet',
  })
}

// ---------------------------------------------------------------------------
// A8 PINNED EPICS
// ---------------------------------------------------------------------------

export function pinnedReport(rows: readonly WallPinRow[], view: WallReportView): string {
  return wallReport({
    title: 'PINNED',
    code: 'A8',
    ...view,
    lines: rows.map(row => [
      reportRow(`${row.projectName} :: ${row.epicId}`, row.epicTitle, `${row.done}/${row.total} (${row.pct}%)`),
      // The pane shows `cap` children and counts the rest; the REPORT carries
      // every open child, because the whole reason to paste a watchlist is to
      // hand someone the list of what is left.
      ...row.children.map(child => reportChild(reportRow(child.marker, child.slug, child.title, `-- ${child.lane}`))),
    ]),
    empty: 'nothing pinned',
  })
}

// ---------------------------------------------------------------------------
// A7 UNATTENDED RUNS
// ---------------------------------------------------------------------------

/**
 * WHAT THIS REPORT DELIBERATELY DOES NOT SAY.
 *
 * The mockup's runs report carries DAG buckets, the overseer lease and the idle
 * reason. None of those are on this pane: `epic_activity` carries no plan and no
 * lease, so each ROW pays for its own `inspect` (see `epic-run-row.tsx`) and the
 * pane never holds the result. A builder that printed `0 in flight` from the
 * absence of a fetch would be inventing the single number this pane exists to
 * make true -- 2026-08-18 was an overseer that never woke while every surface
 * said "running".
 *
 * So the report carries what the PANE knows: the shared vitality verdict (the
 * same `runVitality` the tag, the header badge and the overseer window all read,
 * so no two of them can disagree), the generation, and the live worker count for
 * nightshift. Anything deeper is a click away and says so.
 *
 * IT SPLITS THE SAME TWO WAYS THE PANE DOES, through the same `runSections`.
 * That is not cosmetic: `+ N more running, not inspected` counted every row it
 * had truncated, so once paused runs shared the list it was reporting stopped
 * runs as running -- in a string built to be pasted into WhatsApp and believed.
 */
function liveRunLine(row: UnattendedRow): string {
  if (row.kind === 'nightshift') {
    return reportRow('NIGHTSHIFT', row.projectName, row.runId, `${row.liveWorkers} workers up`)
  }
  const vitality = runView(row.entry)
  const maxGens = row.entry.maxGens > 0 ? `/${row.entry.maxGens}` : ''
  return [
    reportRow('EPIC', row.projectName, row.epicId, vitality.label, `gen ${row.entry.gen}${maxGens}`),
    reportChild(vitality.why),
  ].join('\n')
}

/** A stopped run: what it is, what stopped it, and why -- the reason is the only
 *  field that turns a dead row into an action. */
function tailRunLine({ row, liveness }: TailRow): string {
  const kind = row.kind === 'epic' ? 'EPIC' : 'NIGHTSHIFT'
  return [reportRow(kind, row.projectName, rowTitle(row), liveness.label), reportChild(liveness.why)].join('\n')
}

/**
 * `nowMs` is the PANE's clock, passed in rather than read here. The tail's
 * age-out is arithmetic against a moment, and a report that took its own moment
 * would describe a slightly different pane than the one on screen -- in a string
 * built to be pasted somewhere and believed.
 */
export function runsReport(rows: readonly UnattendedRow[], shown: number, view: WallReportView, nowMs: number): string {
  const { live, tail, cleared } = runSections(rows, nowMs)
  return wallReport({
    title: 'UNATTENDED RUNS',
    code: 'A7',
    ...view,
    lines: [
      ...live.slice(0, shown).map(liveRunLine),
      reportMore(live.length - shown, 'more running, not inspected'),
      tail.length > 0 ? `NOT RUNNING (${tail.length})` : null,
      ...tail.slice(0, shown).map(tailRunLine),
      reportMore(tail.length - shown, 'more not running'),
      // Same rule as every other cap on this pane: a row that left is still a
      // row that existed, and a report that omits it in silence reads as
      // "nothing ended recently".
      reportMore(cleared.length, 'cleared or aged out'),
    ],
    empty: 'nothing is running unattended',
  })
}
