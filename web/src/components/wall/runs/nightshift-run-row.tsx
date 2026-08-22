/**
 * ONE NIGHT RUN: the queue, the workers, and what the watchdog last decided.
 *
 * DELIBERATELY THINNER THAN AN EPIC ROW. A night run has no DAG, no werk-master and
 * no baton -- it has a queue and a watchdog -- so the row shows those four
 * numbers and stops. Padding it out to look like its neighbour would invent
 * structure the engine does not have.
 *
 * Both feeds are per-project and already exist: the run snapshot rides the
 * `nightshift_request {op:'snapshot'}` resource the nightshift screen uses, and
 * the last verdict comes off the watchdog decision log. They are read HERE, in
 * the row, rather than in the list -- so a project with no night run costs
 * nothing, and the row can never disappear after the filter has counted it.
 */

import { useNightshift } from '@/hooks/use-nightshift'
import { useNightshiftWatchdog } from '@/hooks/use-nightshift-watchdog'
import { formatDurationShort } from '@/lib/status-style'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { ProjectTag } from '../../project-tag'
import { NightTag } from './run-bits'
import { nightshiftCounts } from './run-model'
import type { NightshiftRunRowData } from './use-unattended-runs'

/** Verdict -> tone. `observe` is the healthy majority and must stay quiet, or
 *  the one `end` that matters is lost in a wall of green. */
const VERDICT_TONE: Record<string, string> = {
  observe: 'var(--comment)',
  warn: 'var(--warning)',
  end: 'var(--destructive)',
  block: 'var(--event-prompt)',
}

export function NightshiftRunRow({ row, nowMs }: { row: NightshiftRunRowData; nowMs: number }) {
  const { snapshot } = useNightshift(row.project)
  const { decisions } = useNightshiftWatchdog(row.project)
  const toggleProject = useWallFilterStore(s => s.toggleProject)

  // The registry knows how many workers are UP; the artifact knows the queue. A
  // run mid-dispatch legitimately has more live workers than tasks marked
  // running, so the larger of the two is the honest count rather than a lie in
  // whichever direction happened to be written last.
  const counts = nightshiftCounts(snapshot?.tasks ?? [])
  const running = Math.max(counts.running, row.liveWorkers)
  const last = decisions[0]

  return (
    <div className="wall-run" data-night={row.runId}>
      <div className="wall-run-head">
        <NightTag />
        <button
          type="button"
          title={`Filter the whole wall to ${row.projectName}`}
          onClick={() => toggleProject(row.projectName)}
          className="wall-run-proj"
        >
          <ProjectTag name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
        </button>
        <span className="wall-run-name-static">{snapshot?.run.runId ?? row.runId}</span>
        <span className="flex-1" />
        <span className="wall-run-gen">{`${counts.settled} settled`}</span>
      </div>

      <div className="wall-run-buckets">
        <span style={running > 0 ? { color: 'var(--info)' } : undefined}>{running} running</span>
        <span>{counts.queued} queued</span>
        {snapshot?.run.window && <span>{snapshot.run.window}</span>}
      </div>

      {/* The watchdog is the only thing supervising a night run. Silence from it
          is a fact worth printing, not an empty slot to skip. */}
      <div className="wall-run-werk-master" style={last ? { color: VERDICT_TONE[last.verdict] } : undefined}>
        {last
          ? `watchdog ${last.verdict} · ${formatDurationShort(Math.max(0, nowMs - last.at))} ago · ${last.reason}`
          : 'watchdog has not decided anything yet'}
      </div>
    </div>
  )
}
