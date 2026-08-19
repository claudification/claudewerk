/**
 * ONE EPIC RUN: is it moving, why not, who is overseeing it, and what it last did.
 *
 * THE ROW PAYS FOR ITS OWN INSPECT. `epic_activity` -- the feed that puts this
 * row on screen -- deliberately carries no plan, no lease and no baton, because
 * it backs a badge that is on screen permanently. Everything this row is ABOUT
 * costs a board read and a DAG plan, so it is fetched per visible run through
 * `useOverseerInspect`, the same hook the overseer window's detail pane uses:
 * visibility-gated, refetched on reconnect, and honest about its own age. A
 * second inspect client here would be a second set of those bugs.
 *
 * THE ALARM IS THE LEASE. A run whose overseer never woke looks exactly like a
 * healthy one on every other surface in this tree -- that is the 2026-08-18
 * failure -- so a stale lease is rendered in the destructive tone and nothing
 * else on the row is allowed to be louder.
 */

import { useOverseerInspect } from '@/components/overseer/use-overseer-inspect'
import { formatDurationShort } from '@/lib/status-style'
import { useWallFilterStore } from '@/lib/wall/filter-store'
import { ProjectTag } from '../../project-tag'
import { navigateFromWall } from '../wall-navigate'
import { RunActions } from './run-actions'
import { BatonTail, BeatPulse, BucketStrip, RunTag } from './run-bits'
import {
  batonTail,
  beatTicks,
  idleSentence,
  isRunLive,
  type LeaseState,
  leaseState,
  runBuckets,
  runStall,
} from './run-model'
import type { EpicRunRowData } from './use-unattended-runs'

/** The lease, as one sentence. `stale` is the only one that raises its voice. */
function leaseSentence(lease: LeaseState): string {
  const age = lease.sinceMs === null ? 'unknown age' : `${formatDurationShort(lease.sinceMs)} ago`
  if (lease.kind === 'never') return 'overseer has never woken'
  if (lease.kind === 'released') return `overseer released the lease at gen ${lease.gen}`
  if (lease.kind === 'stale') return `STALE LEASE -- ${lease.holder} has held gen ${lease.gen} since ${age}`
  return `overseer ${lease.holder} woke ${age}`
}

// fallow-ignore-next-line complexity -- DEFERRED to `wall-integration-fallow-debt`, which
// owns the split. The model layer is already out (runStall / leaseState / runBuckets /
// idleSentence); what trips the metric is JSX, where every `??` and `&&` counts as a
// decision point. Delete this suppression the day that card lands.
export function EpicRunRow({ row, nowMs }: { row: EpicRunRowData; nowMs: number }) {
  const { entry, project, epicId } = row
  const { data, fetchedAt, stale: readStale, refresh } = useOverseerInspect(project, epicId)
  const toggleProject = useWallFilterStore(s => s.toggleProject)

  const live = isRunLive(entry)
  const stall = runStall(entry, nowMs)
  const lease = leaseState(data?.lease ?? null, entry.overseerAlive, nowMs)
  const idle = idleSentence(entry, data ?? null)
  const gen = data?.run?.gen ?? entry.gen
  const maxGens = data?.run?.maxGens ?? entry.maxGens

  return (
    <div className="wall-run" data-epic={epicId} data-stalled={stall.stalled || undefined}>
      <div className="wall-run-head">
        <RunTag armed={live} />
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
        <BeatPulse ticks={beatTicks(data?.beats ?? [])} />
        <span className="flex-1" />
        <span className="wall-run-gen">
          {`gen ${gen}${maxGens > 0 ? `/${maxGens}` : ''}`}
          {data?.run?.cadence ? ` · ${data.run.cadence}` : ''}
        </span>
      </div>

      {/* A STALLED RUN SAYS SO, WITH THE AGE. Rendering this one as "running" is
          the bug the whole pane exists to kill. */}
      {stall.stalled && (
        <div className="wall-run-stalled">
          {stall.sinceMs === null
            ? 'STALLED -- armed and never beaten'
            : `STALLED -- no beat for ${formatDurationShort(stall.sinceMs)}`}
        </div>
      )}

      <BucketStrip buckets={runBuckets(data ?? null)} />

      <div className={lease.kind === 'stale' ? 'wall-run-overseer wall-run-overseer-bad' : 'wall-run-overseer'}>
        {leaseSentence(lease)}
      </div>

      {/* The broker already computes this sentence every beat and, until this
          pane, threw it away. It is the first thing to read on a run that stopped. */}
      {idle && <div className="wall-run-why">{idle}</div>}

      <BatonTail entries={batonTail(data?.baton ?? [])} nowMs={nowMs} />

      <RunActions project={project} epicId={epicId} run={data?.run ?? null} live={live} onDone={refresh} />

      {/* The inspect timer sleeps with the tab and a sleeping laptop fires none
          at all, so an old read must never pass for a live one. */}
      {readStale && fetchedAt !== null && (
        <div className="wall-run-read">{`read ${formatDurationShort(Math.max(0, nowMs - fetchedAt))} ago`}</div>
      )}
    </div>
  )
}
