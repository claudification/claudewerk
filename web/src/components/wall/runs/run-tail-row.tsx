/**
 * A RUN THAT IS NOT RUNNING -- paused, aborted, finished, or expired.
 *
 * ONE LINE AND A REASON, deliberately. This is the cheap half of A7: the live
 * rows above each pay for their own `inspect` (a sentinel round trip, a board
 * read and a DAG plan), and a paused run has no plan worth planning. Rendering
 * `EpicRunRow` here would make the pane pay full price for the rows nobody is
 * waiting on -- which is how a "just show them too" section quietly triples the
 * cost of an ambient surface.
 *
 * SO IT FETCHES NOTHING, holds no timer and subscribes to nothing. Everything it
 * prints is already in the row it was handed.
 *
 * INERT ON PURPOSE, WITH EXACTLY ONE EXCEPTION. No resume button, no filter
 * chip, no link -- a dimmed row that can be clicked four ways is a control
 * surface pretending to be a note. The exception is CLEAR, because O2 gave a
 * dead run a headstone and no burial: without it this section could only ever
 * grow, and a pane that cannot forget is one you stop reading. A night run has
 * no artifact to acknowledge, so it ages out and carries no button.
 */

import { ProjectTag } from '../../project-tag'
import { RunClearButton } from './run-clear-button'
import type { RowLiveness } from './run-liveness'
import { rowTitle } from './run-liveness'
import type { UnattendedRow } from './use-unattended-runs'

export function RunTailRow({
  row,
  liveness,
  onCleared,
}: {
  row: UnattendedRow
  liveness: RowLiveness
  onCleared: () => void
}) {
  return (
    <div className="wall-run wall-run-tail" data-vitality={liveness.vitality}>
      <div className="wall-run-head">
        <span className="wall-run-tag" data-vitality={liveness.vitality} title={liveness.why}>
          {liveness.label}
        </span>
        <span className="wall-run-proj">
          <ProjectTag name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
        </span>
        <span className="wall-run-name-static">{rowTitle(row)}</span>
        {row.kind === 'epic' && (
          <span className="wall-run-acts">
            <RunClearButton project={row.project} epicId={row.epicId} onDone={onCleared} />
          </span>
        )}
      </div>
      {/* The reason is the whole point of the row. A dimmed line that does not
          say WHICH of paused / aborted / expired it is would be worse than no
          line at all -- it would read as "something is wrong, guess what". */}
      <div className="wall-run-why">{liveness.why}</div>
    </div>
  )
}
