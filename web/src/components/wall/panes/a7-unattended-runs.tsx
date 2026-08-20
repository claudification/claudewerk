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
 * FILTER: `project` and `text`, and nothing else. In particular `managed` is NOT
 * declared, and that is the whole reason this pane is not empty: every row here
 * is machine-dispatched by definition, and the grammar's default is to HIDE
 * machine-dispatched rows. Declaring the axis would blank the pane whenever the
 * filter box was empty -- the exact failure `axes.ts` exists to prevent, arriving
 * through the one door it cannot close for you.
 */

import { useWallFilter } from '@/lib/wall/use-wall-filter'
import { EpicRunRow } from '../runs/epic-run-row'
import { NightshiftRunRow } from '../runs/nightshift-run-row'
import { isRunLive } from '../runs/run-model'
import { type UnattendedRow, useRunClock, useUnattendedRuns } from '../runs/use-unattended-runs'
import { WallPane } from '../wall-pane'

const AXES = ['project', 'text'] as const

/**
 * How many runs render at once.
 *
 * Not a cosmetic cap: every epic row here pays for its own `inspect`, which
 * costs a sentinel round trip, a board read and a DAG plan. Twenty simultaneous
 * runs would turn one open wall into twenty of those every twenty seconds. The
 * remainder is COUNTED AND SAID OUT LOUD below -- a truncated list with no notice
 * reads as "that is everything", which is the one thing it is not.
 */
const RUN_CAP = 6

function Row({ row, nowMs }: { row: UnattendedRow; nowMs: number }) {
  return row.kind === 'epic' ? <EpicRunRow row={row} nowMs={nowMs} /> : <NightshiftRunRow row={row} nowMs={nowMs} />
}

export default function UnattendedRunsPane() {
  const nowMs = useRunClock()
  const { rows: runs, stale } = useUnattendedRuns()
  const { rows, matched, total } = useWallFilter(runs, AXES, row => ({
    project: row.projectName,
    title: row.kind === 'epic' ? row.epicId : row.runId,
    action: row.kind === 'epic' ? 'epic run overseer' : 'nightshift night run',
  }))

  const armed = rows.filter(row => row.kind === 'epic' && isRunLive(row.entry)).length
  const shown = rows.slice(0, RUN_CAP)

  return (
    <WallPane
      title="UNATTENDED RUNS"
      code="A7"
      maxHeight="38%"
      count={`${matched}/${total} · ${armed} armed`}
      stale={stale}
    >
      {rows.length === 0 ? (
        <p className="text-meta text-fg-faint px-0.5 py-1">
          {total === 0 ? 'nothing is running unattended' : 'no unattended run matches'}
        </p>
      ) : (
        shown.map(row => <Row key={row.key} row={row} nowMs={nowMs} />)
      )}
      {rows.length > shown.length && (
        <div className="wall-run-more">{`+ ${rows.length - shown.length} more running, not inspected`}</div>
      )}
    </WallPane>
  )
}
