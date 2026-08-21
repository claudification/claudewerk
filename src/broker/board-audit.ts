/**
 * BOARD AUDIT -- the broker-local record of what the morning report proposed and
 * what pressing Execute actually did. Tier 3 of D7.
 *
 * A SIBLING OF `desk/audit.ts`, NOT AN EXTENSION OF IT. That table answers "why
 * did this dispatch route there?"; this one answers "what happened to this card?"
 * -- the same question aimed at a different noun. Sharing one table would put two
 * unrelated vocabularies behind one `intent` column and make both queries lie by
 * omission. The module-singleton + `openWalDatabase` shape is copied wholesale,
 * because that part IS the same.
 *
 * TWO TABLES, TWO JOBS:
 *
 *   `board_reports`  the machine-readable copy of a brew. The markdown beside the
 *                    cards is written for a human; the surface needs the typed
 *                    proposals back to render them as tickable rows. Also what
 *                    makes STALENESS answerable -- a report is never removed by
 *                    the absence of a successor, so the panel can say "from
 *                    Tuesday" instead of rendering an ambiguous empty page.
 *
 *   `board_actions`  two rows per executed proposal. The INTENT row is written
 *                    before `apply` is called (`awaiting_confirmation = 1`), the
 *                    OUTCOME row after it returns (`executed = 1`, `ok` read off
 *                    what the sentinel reported). Never one row optimistically
 *                    flipped: a failed card write that leaves a log reading
 *                    "moved" is the exact class of confident-but-untrue record
 *                    this epic exists to prevent.
 *
 * PURGEABLE AT 30 DAYS, by design (D7). The card frontmatter (`archived_by`) and
 * the markdown artifact both outlive it, so a purge costs deep forensics and
 * never costs the explanation.
 *
 * Storage: {cacheDir}/board-audit.db
 */

import type { Database, Statement } from 'bun:sqlite'
import { resolve } from 'node:path'
import type { Proposal } from '../shared/board-sweep-proposals'
import type { BoardApplyOutcome, BoardProposalRef, BoardReportRecord } from '../shared/protocol'
import { openWalDatabase } from './sqlite-open'

/** D7's purge horizon. Nothing here is the only copy of anything. */
export const BOARD_AUDIT_RETENTION_DAYS = 30

// ─── Types ──────────────────────────────────────────────────────────

interface ReportRow {
  project: string
  report_date: string
  tz: string
  report_path: string
  proposals_json: string
  snapshot: string
  skipped: number
  selected_count: number
  acted_count: number
  refused_count: number
  idle_reason: string | null
  swept_at: number
}

/** What one press of Execute did to one proposal. `phase` distinguishes the two
 *  rows: `intent` was written before the write, `outcome` after it came back. */
export interface BoardActionRow {
  actionId: string
  project: string
  /** The report the row belongs to -- `report-<date>` is what lands on the card. */
  reportDate: string
  kind: string
  card: string
  /** `flag-duplicate` only: the card it points at. */
  other?: string
  phase: 'intent' | 'outcome'
  /** Outcome rows only. Never inferred from the request. */
  ok?: boolean
  /** The lane the card was read back in, straight from `apply`. */
  status?: string
  archivedReason?: string
  error?: string
  /** One press of Execute = one trace id across every row it produced. */
  traceId: string
  ts: number
}

interface ActionDbRow {
  action_id: string
  project: string
  report_date: string
  kind: string
  card: string
  other: string | null
  phase: string
  awaiting_confirmation: number
  executed: number
  ok: number | null
  status: string | null
  archived_reason: string | null
  error: string | null
  trace_id: string
  ts: number
}

function rowToReport(r: ReportRow): BoardReportRecord {
  return {
    ...(r.idle_reason !== null && { idleReason: r.idle_reason }),
    project: r.project,
    date: r.report_date,
    tz: r.tz,
    reportPath: r.report_path,
    proposals: JSON.parse(r.proposals_json) as Proposal[],
    snapshot: r.snapshot,
    skipped: r.skipped === 1,
    selected: r.selected_count,
    acted: r.acted_count,
    refused: r.refused_count,
    sweptAt: r.swept_at,
  }
}

function rowToAction(r: ActionDbRow): BoardActionRow {
  const out: BoardActionRow = {
    actionId: r.action_id,
    project: r.project,
    reportDate: r.report_date,
    kind: r.kind,
    card: r.card,
    phase: r.phase as BoardActionRow['phase'],
    traceId: r.trace_id,
    ts: r.ts,
  }
  if (r.other !== null) out.other = r.other
  if (r.ok !== null) out.ok = r.ok === 1
  if (r.status !== null) out.status = r.status
  if (r.archived_reason !== null) out.archivedReason = r.archived_reason
  if (r.error !== null) out.error = r.error
  return out
}

// ─── Module State ───────────────────────────────────────────────────

let db: Database | null = null
let stmtUpsertReport: Statement | null = null
let stmtLatestReport: Statement | null = null
let stmtInsertAction: Statement | null = null
let stmtListActions: Statement | null = null
let stmtPurge: Statement | null = null

// ─── Init / Shutdown ────────────────────────────────────────────────

export function initBoardAudit(cacheDir: string): void {
  db = openWalDatabase(resolve(cacheDir, 'board-audit.db'))

  // PRIMARY KEY (project, report_date): re-recording the same date REPLACES it.
  // A sweep that runs twice in a morning is one report, not two, and the second
  // pass carries the fresher board.
  db.run(`
    CREATE TABLE IF NOT EXISTS board_reports (
      project TEXT NOT NULL,
      report_date TEXT NOT NULL,
      tz TEXT NOT NULL,
      report_path TEXT NOT NULL,
      proposals_json TEXT NOT NULL,
      snapshot TEXT NOT NULL,
      skipped INTEGER NOT NULL DEFAULT 0,
      selected_count INTEGER NOT NULL DEFAULT 0,
      acted_count INTEGER NOT NULL DEFAULT 0,
      refused_count INTEGER NOT NULL DEFAULT 0,
      idle_reason TEXT,
      swept_at INTEGER NOT NULL,
      PRIMARY KEY (project, report_date)
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_board_reports_swept ON board_reports(project, swept_at)`)

  db.run(`
    CREATE TABLE IF NOT EXISTS board_actions (
      action_id TEXT PRIMARY KEY,
      project TEXT NOT NULL,
      report_date TEXT NOT NULL,
      kind TEXT NOT NULL,
      card TEXT NOT NULL,
      other TEXT,
      phase TEXT NOT NULL,
      awaiting_confirmation INTEGER NOT NULL DEFAULT 0,
      executed INTEGER NOT NULL DEFAULT 0,
      ok INTEGER,
      status TEXT,
      archived_reason TEXT,
      error TEXT,
      trace_id TEXT NOT NULL,
      ts INTEGER NOT NULL
    )
  `)
  db.run(`CREATE INDEX IF NOT EXISTS idx_board_actions_project_ts ON board_actions(project, ts)`)
  db.run(`CREATE INDEX IF NOT EXISTS idx_board_actions_card ON board_actions(card)`)

  stmtUpsertReport = db.prepare(`
    INSERT INTO board_reports
      (project, report_date, tz, report_path, proposals_json, snapshot,
       skipped, selected_count, acted_count, refused_count, idle_reason, swept_at)
    VALUES
      ($project, $report_date, $tz, $report_path, $proposals_json, $snapshot,
       $skipped, $selected_count, $acted_count, $refused_count, $idle_reason, $swept_at)
    ON CONFLICT(project, report_date) DO UPDATE SET
      tz = excluded.tz,
      report_path = excluded.report_path,
      proposals_json = excluded.proposals_json,
      snapshot = excluded.snapshot,
      skipped = excluded.skipped,
      selected_count = excluded.selected_count,
      acted_count = excluded.acted_count,
      refused_count = excluded.refused_count,
      idle_reason = excluded.idle_reason,
      swept_at = excluded.swept_at
  `)
  // Ordered by DATE, not by `swept_at`: a re-record bumps the clock, and the
  // report a human means by "the latest one" is the one with the newest name.
  stmtLatestReport = db.prepare(
    `SELECT * FROM board_reports WHERE project = $project ORDER BY report_date DESC LIMIT 1`,
  )
  stmtInsertAction = db.prepare(`
    INSERT INTO board_actions
      (action_id, project, report_date, kind, card, other, phase,
       awaiting_confirmation, executed, ok, status, archived_reason, error, trace_id, ts)
    VALUES
      ($action_id, $project, $report_date, $kind, $card, $other, $phase,
       $awaiting_confirmation, $executed, $ok, $status, $archived_reason, $error, $trace_id, $ts)
  `)
  stmtListActions = db.prepare(
    `SELECT * FROM board_actions WHERE project = $project ORDER BY ts DESC, rowid DESC LIMIT $limit`,
  )
  stmtPurge = db.prepare(`DELETE FROM board_actions WHERE ts < $before`)
}

export function closeBoardAudit(): void {
  db?.close()
  db = null
  stmtUpsertReport = stmtLatestReport = stmtInsertAction = stmtListActions = stmtPurge = null
}

// ─── Reports ────────────────────────────────────────────────────────

/** Record (or replace) one morning report. Called when the sweep comes back. */
export function recordBoardReport(report: BoardReportRecord): void {
  if (!stmtUpsertReport) throw new Error('board audit store not initialised')
  stmtUpsertReport.run({
    project: report.project,
    report_date: report.date,
    tz: report.tz,
    report_path: report.reportPath,
    proposals_json: JSON.stringify(report.proposals),
    snapshot: report.snapshot,
    skipped: report.skipped ? 1 : 0,
    selected_count: report.selected,
    acted_count: report.acted,
    refused_count: report.refused,
    idle_reason: report.idleReason ?? null,
    swept_at: report.sweptAt,
  })
}

/**
 * The most recent report for a project, or null if no sweep has ever landed.
 *
 * NULL IS AN ANSWER, and the surface renders it as one: "no brew has ever
 * arrived" is the health signal this whole feature was built to make visible. It
 * is never a reason to go and compute one.
 */
export function latestBoardReport(project: string): BoardReportRecord | null {
  if (!stmtLatestReport) throw new Error('board audit store not initialised')
  const row = stmtLatestReport.get({ project }) as ReportRow | null
  return row ? rowToReport(row) : null
}

// ─── Actions ────────────────────────────────────────────────────────

/** SQLite has no undefined and no boolean. Two one-liners rather than a ternary
 *  per column: the mapping is the same every time and reads better named. */
function orNull<T>(value: T | undefined): T | null {
  return value ?? null
}
function flag(value: boolean | undefined): number | null {
  return value === undefined ? null : Number(value)
}

function insertAction(row: BoardActionRow): void {
  if (!stmtInsertAction) throw new Error('board audit store not initialised')
  stmtInsertAction.run({
    action_id: row.actionId,
    project: row.project,
    report_date: row.reportDate,
    kind: row.kind,
    card: row.card,
    other: orNull(row.other),
    phase: row.phase,
    awaiting_confirmation: Number(row.phase === 'intent'),
    executed: Number(row.phase === 'outcome'),
    ok: flag(row.ok),
    status: orNull(row.status),
    archived_reason: orNull(row.archivedReason),
    error: orNull(row.error),
    trace_id: row.traceId,
    ts: row.ts,
  })
}

/**
 * "A human ticked this and pressed Execute." Written BEFORE `apply` is called.
 *
 * The pair matters more than either row: an intent with no outcome beside it is
 * a press that never came back, which is a thing you want to be able to see.
 */
export function recordBoardIntent(args: {
  project: string
  reportDate: string
  proposal: BoardProposalRef
  traceId: string
  ts: number
}): void {
  insertAction({
    actionId: `${args.traceId}:intent:${args.proposal.kind}:${args.proposal.card}`,
    project: args.project,
    reportDate: args.reportDate,
    kind: args.proposal.kind,
    card: args.proposal.card,
    other: args.proposal.other,
    phase: 'intent',
    traceId: args.traceId,
    ts: args.ts,
  })
}

/**
 * What `apply` reported back, per proposal. Written AFTER the write returned.
 *
 * `ok` comes off the outcome the sentinel produced by reading the card back off
 * disk. Nothing here may be derived from the request.
 */
export function recordBoardOutcome(args: {
  project: string
  reportDate: string
  outcome: BoardApplyOutcome
  traceId: string
  ts: number
}): void {
  insertAction({
    actionId: `${args.traceId}:outcome:${args.outcome.kind}:${args.outcome.card}`,
    project: args.project,
    reportDate: args.reportDate,
    kind: args.outcome.kind,
    card: args.outcome.card,
    phase: 'outcome',
    ok: args.outcome.ok,
    status: args.outcome.status,
    archivedReason: args.outcome.archivedReason,
    error: args.outcome.error,
    traceId: args.traceId,
    ts: args.ts,
  })
}

/** Newest first. The forensics view, and what a test reads to prove ordering. */
export function listBoardActions(project: string, limit = 100): BoardActionRow[] {
  if (!stmtListActions) throw new Error('board audit store not initialised')
  return (stmtListActions.all({ project, limit }) as ActionDbRow[]).map(rowToAction)
}

/** Drop action rows older than the retention horizon. Reports are NOT purged --
 *  they are the surface's only source and there is one small row per day. */
export function purgeBoardActions(now: number, retentionDays = BOARD_AUDIT_RETENTION_DAYS): number {
  if (!stmtPurge) throw new Error('board audit store not initialised')
  return stmtPurge.run({ before: now - retentionDays * 86_400_000 }).changes
}
