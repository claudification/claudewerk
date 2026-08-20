/**
 * THE REPORT BUILDERS for the six panes that are a set of READINGS rather than a
 * list of events -- A2 burn, S1 host vitals, S2 plan usage, A6 sheaf, A4 state of
 * the union, P4 fleet. The event panes live in `pane-reports.ts`.
 *
 * Pure, like the others, and for the same reason: a report is a claim about
 * numbers and a claim about numbers has to be testable without a browser.
 *
 * THE DASH SURVIVES THE CLIPBOARD. Every pane here can be missing a feed, and
 * each one already renders `--` rather than a zero when it is. A report that
 * turned that dash into `0%` would paste a measurement nobody took, which is the
 * one failure mode a wall must not have -- so an unknown reading stays a dash all
 * the way into the paste.
 */

import type { PlanLine } from '@/components/wall/plan/plan-model'
import type { WallReading } from '@/components/wall/wall-reading-bus'
import type { BurnCapState, BurnSplit } from './burn-splits'
import { formatUsd } from './burn-splits'
import { type HostVitalsRow, vitalsLine } from './host-vitals'
import { reportChild, reportMore, reportParens, reportRow, type WallReportView, wallReport } from './report'
import { formatTokens, type SheafRow, type SheafView, type SotuBlock, type SotuPill } from './sheaf-rows'

/** A dollar figure that may not have arrived. `formatUsd` already dashes on
 *  null/undefined -- this names the intent at the call site. */
const usdOrDash = (usd: number | null | undefined): string => formatUsd(usd)

// ---------------------------------------------------------------------------
// A2 BURN
// ---------------------------------------------------------------------------

export interface BurnReportInput {
  /** The headline rate exactly as `BurnLive` printed it (`$11.40/h`, `--`). */
  rate: string
  todayUsd: number | null
  monthUsd: number | null
  cap: BurnCapState
  /** Per-project spend. Work done FOR something. */
  projects: BurnSplit
  /** OpenRouter spend BY FEATURE. The panel's own infrastructure. */
  features: BurnSplit
  /** The window both splits cover, as the pane labels it. */
  window: string
}

/** The cap, in the words the tile uses -- including `no cap`, which is the state
 *  the fleet has actually been in and the one worth pasting into a warning. */
function capLine(cap: BurnCapState): string {
  if (cap.kind === 'none') return 'no cap'
  return `cap ${formatUsd(cap.capUsd)} (${Math.round(cap.share * 100)}%${cap.over ? ', OVER' : ''})`
}

/**
 * THE TWO SPLITS ARE NEVER SUMMED, and the report keeps them apart the same way
 * the pane does: separate headings, separate totals, separate windows. A single
 * merged list of bars would read as one quantity, which is the exact misreading
 * `burn-splits.ts` was written to prevent.
 */
function splitLines(title: string, split: BurnSplit, window: string): string[] {
  if (split.bars.length === 0) return []
  return [
    `${title} (${window}, ${formatUsd(split.total)})`,
    ...split.bars.map(bar =>
      reportChild(reportRow(formatUsd(bar.costUsd), `${Math.round(bar.share * 100)}%`, bar.label)),
    ),
  ]
}

export function burnReport(input: BurnReportInput, view: WallReportView): string {
  return wallReport({
    title: 'BURN',
    code: 'A2',
    ...view,
    lines: [
      reportRow(
        `rate ${input.rate}`,
        `today ${usdOrDash(input.todayUsd)}`,
        `month ${usdOrDash(input.monthUsd)}`,
        capLine(input.cap),
      ),
      splitLines('PROJECTS', input.projects, input.window),
      splitLines('OPENROUTER', input.features, input.window),
    ],
    empty: 'nothing billed',
  })
}

// ---------------------------------------------------------------------------
// S1 HOST VITALS
// ---------------------------------------------------------------------------

/**
 * `vitalsLine` is what an S1 ROW's own copy button yields, and the report is
 * those same lines stacked. Deliberately not a second format: someone pasting a
 * whole pane and someone pasting one host must produce the same sentence about
 * that host, or the two pastes start an argument about which was right.
 */
export function hostVitalsReport(rows: readonly HostVitalsRow[], view: WallReportView): string {
  return wallReport({
    title: 'HOST VITALS',
    code: 'S1',
    ...view,
    lines: rows.map(vitalsLine),
    empty: 'no node reporting',
  })
}

// ---------------------------------------------------------------------------
// S2 PLAN USAGE
// ---------------------------------------------------------------------------

/** `resets in 2h14m`, or nothing when the window carries no reset. */
function resetIn(resetsAt: number | undefined, now: number): string | null {
  if (!resetsAt || resetsAt <= now) return null
  const mins = Math.round((resetsAt - now) / 60_000)
  const h = Math.floor(mins / 60)
  return h === 0 ? `resets in ${mins}m` : `resets in ${h}h${mins % 60}m`
}

/**
 * `now` is the CHART's right edge, not the wall clock -- rewound, the pane draws
 * a window that ends at the cursor and the reset countdown has to be measured
 * against the same edge or the paste and the chart disagree by the offset.
 */
export function planUsageReport(lines: readonly PlanLine[], now: number, view: WallReportView): string {
  return wallReport({
    title: 'PLAN USAGE',
    code: 'S2',
    ...view,
    lines: lines.map(line =>
      reportRow(
        line.node ? `${line.profile}@${line.node}` : line.profile,
        // `utilization` only means anything when the sample is OK; every other
        // state is a reason there is no number, and it says so instead.
        line.latest.state === 'ok' ? `${Math.round(line.latest.utilization)}%` : line.latest.state,
        resetIn(line.latest.resetsAt, now),
      ),
    ),
    empty: 'no plan usage reported',
  })
}

// ---------------------------------------------------------------------------
// A6 SHEAF
// ---------------------------------------------------------------------------

function sheafRowLine(row: SheafRow): string {
  return reportRow(
    formatUsd(row.costUsd),
    `${row.conversations} conv`,
    `${row.trees} trees`,
    `${formatTokens(row.inputTokens)} in/${formatTokens(row.outputTokens)} out`,
    row.projectName,
    reportParens(
      row.unmergedCommits > 0 ? `${row.unmergedCommits} unmerged` : null,
      row.alerts.length > 0 ? `ALERTS: ${row.alerts.join(', ')}` : null,
    ),
  )
}

export function sheafReport(sheaf: SheafView | null, rows: readonly SheafRow[], view: WallReportView): string {
  return wallReport({
    title: 'SHEAF',
    code: 'A6',
    ...view,
    lines: [
      sheaf
        ? reportRow(
            `${sheaf.windowH}h window`,
            `${formatUsd(sheaf.totals.costUsd)} spent`,
            `${sheaf.totals.conversations} conversations`,
            `${sheaf.totals.trees} spawn trees`,
          )
        : null,
      ...rows.map(sheafRowLine),
      // The summariser keeps the top projects by cost. A paste that stopped at
      // the clip would read as the whole ledger.
      reportMore(sheaf?.clipped ?? 0, 'lower-cost projects clipped'),
    ],
    empty: 'nothing spent in this window',
  })
}

// ---------------------------------------------------------------------------
// A4 STATE OF THE UNION
// ---------------------------------------------------------------------------

/**
 * THE PROSE IS THE PAYLOAD. The mockup built this report by scraping the pane's
 * `innerText`, which is precisely the shape this card exists to refuse: the
 * narrative is a paragraph the browser has already wrapped and clipped by the
 * time it is in the DOM. It comes from the block instead, whole.
 */
export function sotuReport(pills: readonly SotuPill[], blocks: readonly SotuBlock[], view: WallReportView): string {
  return wallReport({
    title: 'STATE OF THE UNION',
    code: 'A4',
    ...view,
    lines: [
      pills.length > 0 ? pills.map(p => p.label).join(' · ') : null,
      ...blocks.map(block => [
        reportRow(
          block.projectName,
          block.alerts.length > 0 ? block.alerts.join(', ') : null,
          block.unmerged > 0 ? `${block.unmerged} unmerged` : null,
          block.contended > 0 ? `${block.contended} contended` : null,
        ),
        reportChild(block.narrative ?? (block.quiet === 'not-enabled' ? 'chronicle off' : 'nothing distilled yet')),
      ]),
    ],
    empty: 'no project reports a state',
  })
}

// ---------------------------------------------------------------------------
// P4 FLEET
// ---------------------------------------------------------------------------

/**
 * Built from what the TILES published (`wall-reading-bus`), because each tile
 * owns its own feed and the pane holds none of the four numbers. A tile that is
 * not mounted -- filtered away -- has no reading, so it is absent from the report
 * rather than reported as zero.
 */
export function fleetReport(readings: readonly WallReading[], view: WallReportView): string {
  return wallReport({
    title: 'FLEET',
    code: 'P4',
    ...view,
    lines: readings.map(r =>
      reportRow(r.label, r.value ?? '--', r.stale ? 'STALE' : null, r.sub ? `(${r.sub})` : null),
    ),
    empty: 'no tile matches the filter',
  })
}
