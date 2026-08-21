/**
 * Publishing a fresh brew: record it, then tell anyone who is looking.
 *
 * The scheduled sweep is the only writer. It hands over the `BoardSweepResult`
 * the sentinel produced; this turns it into the machine-readable record the
 * surface renders (`board-audit.db`) and pushes it to the panel.
 *
 * WHY THE PUSH EXISTS. The surface is parkable, and parking it is the expected
 * thing to do -- you leave the brew in the dock and come back to it. A parked
 * surface that never learns a newer report landed would sit on yesterday's rows
 * and its dock tile would never pulse, which is precisely the "something is
 * waiting for you" case the tile was built for. EVERYTHING IS A STRUCTURED
 * MESSAGE, and this is one, so nothing has to poll.
 *
 * RECORD FIRST, BROADCAST SECOND. A panel told about a report the database does
 * not have yet would fetch it and get the previous one back.
 */

import type { ServerWebSocket } from 'bun'
import type { BoardReportRecord, BoardSweepResult } from '../shared/protocol'
import { recordBoardReport } from './board-audit'

/** The wire shape of what one sweep produced, for the record and the push. */
function boardReportRecord(project: string, tz: string, sweep: BoardSweepResult, sweptAt: number): BoardReportRecord {
  return {
    project,
    date: sweep.reportDate,
    tz,
    reportPath: sweep.reportPath,
    proposals: sweep.proposals,
    snapshot: sweep.snapshot,
    skipped: sweep.skipped,
    selected: sweep.selected.length,
    acted: sweep.acted.length,
    refused: sweep.refused.length,
    ...(sweep.idleReason !== undefined && { idleReason: sweep.idleReason }),
    sweptAt,
  }
}

/**
 * Record one sweep's report and push it to the control panel.
 *
 * A broadcast failure is never allowed to lose the record: the write has already
 * happened by the time a socket is touched, and a dead socket is the registry's
 * problem, not the sweep's.
 */
export function publishBoardReport(
  subscribers: Iterable<ServerWebSocket<unknown>>,
  project: string,
  tz: string,
  sweep: BoardSweepResult,
  sweptAt: number,
): BoardReportRecord {
  const report = boardReportRecord(project, tz, sweep, sweptAt)
  recordBoardReport(report)

  const json = JSON.stringify({ type: 'board_report_changed', project, report })
  for (const ws of subscribers) {
    try {
      ws.send(json)
    } catch {
      /* dead socket -- the registry reaps it */
    }
  }
  return report
}
