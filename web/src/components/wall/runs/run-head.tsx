/**
 * THE FIRST LINE OF A RUN ROW: who it is, whether it is armed, which generation,
 * and how long ago it last beat.
 *
 * Its own file because it is the only part of the row that TALKS BACK -- two
 * buttons, one of which re-filters the entire wall -- while everything below it
 * on the row is a read-only strip of numbers. It also owns the wall-filter store
 * read, and a component that subscribes to a store has no business sharing a
 * file with ones that do not.
 *
 * `gen` and `maxGens` prefer the inspect read and fall back to the activity
 * entry: inspect is fetched per visible run and can be a beat fresher, but the
 * entry is what put the row on screen and is never absent.
 */

import type { RunVitalityView } from '@shared/epic-vitality'
import type { EpicBeatRecord, EpicRunSnapshot } from '@shared/protocol'
import { formatDurationShort } from '@/lib/status-style'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { ProjectTag } from '../../project-tag'
import { navigateFromWall } from '../wall-navigate'
import { BeatPulse, RunTag } from './run-bits'
import type { RunStall } from './run-model'
import { beatTicks } from './run-tails'
import type { EpicRunRowData } from './use-unattended-runs'

/**
 * GENERATION, CADENCE, LAST BEAT -- the run's progress and its timing, right-aligned.
 *
 * The beat age is here rather than on a line of its own because it is the same
 * question as the generation: how far has this got, and how recently. Without it
 * a healthy run and one that last moved forty minutes ago are the same row.
 * Suppressed while STALLED -- the banner directly below prints the same age in
 * the alarm tone, and saying it twice makes neither copy louder.
 */
function RunProgress({
  run,
  gen,
  maxGens,
  stall,
}: {
  run: EpicRunSnapshot | null
  gen: number
  maxGens: number
  stall: RunStall
}) {
  return (
    <span className="wall-run-gen">
      {`gen ${gen}${maxGens > 0 ? `/${maxGens}` : ''}`}
      {run?.cadence ? ` · ${run.cadence}` : ''}
      {!stall.stalled && stall.sinceMs !== null ? ` · beat ${formatDurationShort(stall.sinceMs)}` : ''}
    </span>
  )
}

export function RunHead({
  row,
  view,
  run,
  beats,
  stall,
}: {
  row: EpicRunRowData
  view: RunVitalityView
  run: EpicRunSnapshot | null
  beats: readonly EpicBeatRecord[]
  stall: RunStall
}) {
  const toggleProject = useWallFilterStore(s => s.toggleProject)
  const { entry, project, epicId } = row

  return (
    <div className="wall-run-head">
      <RunTag view={view} />
      <button
        type="button"
        title={`Filter the whole wall to ${row.projectName}`}
        onClick={() => toggleProject(row.projectName)}
        className="wall-run-proj"
      >
        <ProjectTag name={row.projectName} icon={row.projectIcon} color={row.projectColor} />
      </button>
      <button
        type="button"
        title="Click -- the MAIN window opens this epic. The wall stays put."
        onClick={() => navigateFromWall({ kind: 'epic', project, id: epicId })}
        className="wall-run-name"
      >
        {epicId}
      </button>
      <BeatPulse ticks={beatTicks(beats)} />
      <span className="flex-1" />
      <RunProgress run={run} gen={run?.gen ?? entry.gen} maxGens={run?.maxGens ?? entry.maxGens} stall={stall} />
    </div>
  )
}
