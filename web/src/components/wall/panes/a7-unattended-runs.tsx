/**
 * A7 UNATTENDED RUNS -- epic runs, the overseer, and nightshift, on one pane.
 *
 * The fleet runs itself now, and until this pane the only way to know whether any
 * of it was actually moving was `epic_run action=inspect` from inside a
 * conversation. That is a debug command, not a surface, and a run that silently
 * stopped looked exactly like a run that was thinking. On 2026-08-18 an epic run
 * completed its loop, the OVERSEER NEVER WOKE, and nothing said so.
 *
 * READ-MOSTLY. Three verbs live here -- beat, pause, resume -- each behind a
 * second click. ABORT is deliberately not on this pane: a terminal action does
 * not belong on a surface built to be glanced at.
 *
 * FILTER: `project`, `workspace` (resolved from the project name) and `text`,
 * and nothing else. In particular `managed` is NOT
 * declared, and that is the whole reason this pane is not empty: every row here
 * is machine-dispatched by definition, and the grammar's default is to HIDE
 * machine-dispatched rows. Declaring the axis would blank the pane whenever the
 * filter box was empty -- the exact failure `axes.ts` exists to prevent, arriving
 * through the one door it cannot close for you.
 *
 * TWO SECTIONS, ONE LIVENESS TEST. Live runs first, at full weight; paused,
 * aborted, finished and expired ones under them, dimmed, each carrying its
 * reason. `run-liveness.ts` makes that call once for both feeds -- the pane does
 * not get a second opinion, which is precisely what it used to have. The tail is
 * NOT a filter and NOT a toggle: nothing is hidden, it is ranked.
 */

import { runsReport } from '@/lib/wall/pane-reports'
import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { useWallReportView } from '@/lib/wall/use-wall-report-view'
import { EpicRunRow } from '../runs/epic-run-row'
import { NightshiftRunRow } from '../runs/nightshift-run-row'
import { rowTitle, runSections, type TailRow } from '../runs/run-liveness'
import { RunTailRow } from '../runs/run-tail-row'
import { type UnattendedRow, useRunClock, useUnattendedRuns } from '../runs/use-unattended-runs'
import { WallPane } from '../wall-pane'

const AXES = ['project', 'workspace', 'text'] as const

/**
 * How many LIVE runs render at once.
 *
 * Not a cosmetic cap: every epic row here pays for its own `inspect`, which
 * costs a sentinel round trip, a board read and a DAG plan. Twenty simultaneous
 * runs would turn one open wall into twenty of those every twenty seconds. The
 * remainder is COUNTED AND SAID OUT LOUD below -- a truncated list with no notice
 * reads as "that is everything", which is the one thing it is not.
 */
const RUN_CAP = 6

/**
 * How many dimmed rows the tail shows.
 *
 * A separate number because it is bounded for a different reason: a tail row
 * fetches nothing, so this is about the pane's height and not its cost. It is
 * still said out loud when it bites -- an unnoticed run is the exact failure
 * this section exists to prevent, and truncating it in silence would rebuild it
 * one row further down.
 */
const TAIL_CAP = 6

function Row({ row, nowMs }: { row: UnattendedRow; nowMs: number }) {
  return row.kind === 'epic' ? <EpicRunRow row={row} nowMs={nowMs} /> : <NightshiftRunRow row={row} nowMs={nowMs} />
}

/** The dimmed half: a heading that counts, the rows, and the truncation notice. */
function NotRunning({
  tail,
  cleared,
  onCleared,
}: {
  tail: readonly TailRow[]
  cleared: number
  onCleared: () => void
}) {
  if (tail.length === 0 && cleared === 0) return null
  const shown = tail.slice(0, TAIL_CAP)
  return (
    <div className="wall-run-tail-section">
      <div className="wall-run-tail-head">{`not running · ${tail.length}`}</div>
      {shown.map(({ row, liveness }) => (
        <RunTailRow key={row.key} row={row} liveness={liveness} onCleared={onCleared} />
      ))}
      {tail.length > shown.length && (
        <div className="wall-run-more">{`+ ${tail.length - shown.length} more not running`}</div>
      )}
      {/* NO SILENT CAPS. A row that left the pane is still a row that existed,
          and a surface that drops rows without saying so reads as "nothing
          ended recently" -- the lie O2 was written to prevent. */}
      {cleared > 0 && <div className="wall-run-more">{`+ ${cleared} cleared or aged out`}</div>}
    </div>
  )
}

export default function UnattendedRunsPane() {
  const nowMs = useRunClock()
  const { rows: runs, stale, reprime } = useUnattendedRuns()
  const { rows, matched, total } = useWallFilter(runs, AXES, row => ({
    project: row.projectName,
    title: rowTitle(row),
    action: row.kind === 'epic' ? 'epic run overseer' : 'nightshift night run',
  }))

  const { live, tail, cleared } = runSections(rows, nowMs)
  const shown = live.slice(0, RUN_CAP)
  const view = useWallReportView()

  return (
    <WallPane
      title="UNATTENDED RUNS"
      code="A7"
      maxHeight="38%"
      count={`${matched}/${total} · ${live.length} live`}
      stale={stale}
      // The cap goes into the builder rather than the sliced rows, so the report
      // can count what it left out instead of dropping it in silence.
      report={() => runsReport(rows, RUN_CAP, view, nowMs)}
    >
      {rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0 ? 'nothing is running unattended' : 'no unattended run matches'}
        </p>
      ) : (
        shown.map(row => <Row key={row.key} row={row} nowMs={nowMs} />)
      )}
      {live.length > shown.length && (
        <div className="wall-run-more">{`+ ${live.length - shown.length} more running, not inspected`}</div>
      )}
      <NotRunning tail={tail} cleared={cleared.length} onCleared={reprime} />
    </WallPane>
  )
}
