/**
 * ONE EPIC RUN: is it moving, why not, who is overseeing it, and what it last did.
 *
 * THE ROW PAYS FOR ITS OWN INSPECT. `epic_activity` -- the feed that puts this
 * row on screen -- deliberately carries no plan, no lease and no baton, because
 * it backs a badge that is on screen permanently. Everything this row is ABOUT
 * costs a board read and a DAG plan, so it is fetched per visible run through
 * `useWerkMasterInspect`, the same hook the werk-master window's detail pane uses:
 * visibility-gated, refetched on reconnect, and honest about its own age. A
 * second inspect client here would be a second set of those bugs.
 *
 * THE ALARM IS THE LEASE. A run whose werk-master never woke looks exactly like a
 * healthy one on every other surface in this tree -- that is the 2026-08-18
 * failure -- so a stale lease is rendered in the destructive tone and nothing
 * else on the row is allowed to be louder.
 */

import { whenWaitingLine } from '@shared/epic-when'
import type { EpicQueueReading, EpicRunSnapshot } from '@shared/protocol'
import { useWerkMasterInspect } from '@/components/werk-master/use-werk-master-inspect'
import { type LeaseState, leaseSentence, leaseState } from '@/lib/epic-lease-view'
import { formatDurationShort } from '@/lib/status-style'
import { RunActions } from './run-actions'
import { BatonTail, BucketStrip, CapStrip } from './run-bits'
import { RunHead } from './run-head'
import { idleSentence, type RunStall, runBuckets, runCaps, runStall, runView } from './run-model'
import { batonTail } from './run-tails'
import type { EpicRunRowData } from './use-unattended-runs'

/** A STALLED RUN SAYS SO, WITH THE AGE. Rendering this one as "running" is the
 *  bug the whole pane exists to kill -- so the not-stalled case renders nothing
 *  HERE rather than being guarded by the caller, where it could be forgotten. */
function StallBanner({ stall }: { stall: RunStall }) {
  if (!stall.stalled) return null
  return (
    <div className="wall-run-stalled">
      {stall.sinceMs === null
        ? 'STALLED -- armed and never beaten'
        : `STALLED -- no beat for ${formatDurationShort(stall.sinceMs)}`}
    </div>
  )
}

/** THE ALARM. A run whose werk-master never woke looks healthy on every other
 *  surface in this tree -- that is the 2026-08-18 failure -- so a stale lease
 *  takes the destructive tone and nothing else on the row is allowed to be
 *  louder. */
function LeaseLine({ lease }: { lease: LeaseState }) {
  const tone = lease.kind === 'stale' ? 'wall-run-werk-master wall-run-werk-master-bad' : 'wall-run-werk-master'
  return <div className={tone}>{leaseSentence(lease)}</div>
}

/**
 * WAITING IS NOT IDLE. A run held by the queue gate has nothing in flight and no
 * beat to show for itself, which on every other line of this row is
 * indistinguishable from a run that has quietly died -- so it says which, with
 * its position, every tick. The broker computes the sentence (`epic-queue.ts`);
 * this only refuses to throw it away.
 */
function QueueLine({ queue }: { queue: EpicQueueReading | undefined }) {
  if (!queue) return null
  return <div className={queue.blocked ? 'wall-run-why' : 'wall-run-werk-master'}>{queue.reason}</div>
}

/**
 * WAITING ON THE CLOCK IS NOT IDLE -- the same rule as `QueueLine`, one gate over.
 *
 * A run armed for 02:00 has nothing in flight, no seat and no fresh beat to show
 * for itself, which is byte-for-byte what a dead run looks like on every other
 * line of this row. So it prints the appointment and the countdown, and it never
 * prints a bare time: the instant carries the offset it was set in, so it can be
 * checked against a wall clock in any zone (`format-when.ts`'s rule).
 *
 * Computed from `run.cadence` rather than fetched, and that is the whole reason
 * this needs no wire field: the appointment IS the state, it already crosses on
 * the run snapshot, and a broker that computed a second copy of the countdown
 * would be a rail that can disagree with the beat holding the run.
 */
function WhenLine({ run, nowMs }: { run: EpicRunSnapshot | null; nowMs: number }) {
  const waiting = run ? whenWaitingLine(run.cadence, nowMs) : null
  if (!waiting) return null
  return <div className="wall-run-why">{`WAITING -- ${waiting}`}</div>
}

/** WHY IT IS NOT MOVING. The broker computes this sentence every beat and, until
 *  this pane, threw it away. It is the first thing to read on a run that
 *  stopped. */
function IdleWhy({ sentence }: { sentence: string | null }) {
  if (!sentence) return null
  return <div className="wall-run-why">{sentence}</div>
}

/** HOW OLD THE READ IS. The inspect timer sleeps with the tab and a sleeping
 *  laptop fires none at all, so an old read must never pass for a live one. */
function ReadAge({ stale, fetchedAt, nowMs }: { stale: boolean; fetchedAt: number | null; nowMs: number }) {
  if (!stale || fetchedAt === null) return null
  return <div className="wall-run-read">{`read ${formatDurationShort(Math.max(0, nowMs - fetchedAt))} ago`}</div>
}

/**
 * The row itself: the inspect fetch, the model reads, and the ORDER the blocks
 * appear in. Every block above renders itself or nothing, so this is a list of
 * what a run row is made of and not a tree of conditions.
 */
export function EpicRunRow({ row, nowMs }: { row: EpicRunRowData; nowMs: number }) {
  const { entry, project, epicId } = row
  const { data, fetchedAt, stale: readStale, refresh } = useWerkMasterInspect(project, epicId)

  const view = runView(entry)
  const stall = runStall(entry, nowMs)
  const inspect = data ?? null
  const run = inspect?.run ?? null

  return (
    <div className="wall-run" data-epic={epicId} data-stalled={stall.stalled || undefined}>
      <RunHead row={row} view={view} run={run} beats={inspect?.beats ?? []} stall={stall} />
      <StallBanner stall={stall} />
      {/* WHY the tag says what it says. The tag alone is what let three surfaces
          each print a different confident word for the same run. */}
      <div className="wall-run-why">{view.why}</div>
      {/* The inspect read is a beat fresher when it has one; the entry is what
          put the row on screen and is never absent. Same rule as `gen`. */}
      <QueueLine queue={inspect?.queue ?? entry.queue} />
      {/* Above the buckets for the same reason the queue line is: "why is nothing
          dispatching" has a different answer for a run waiting on the clock than
          the DAG's, and printing the DAG's first sends the reader hunting through
          card lanes for a reason that is not there. */}
      <WhenLine run={run} nowMs={nowMs} />
      <BucketStrip buckets={runBuckets(inspect)} />
      <CapStrip caps={runCaps(run, nowMs)} />
      <LeaseLine lease={leaseState(inspect?.lease ?? null, entry.werkMasterAlive, nowMs)} />
      <IdleWhy sentence={idleSentence(entry, inspect)} />
      <BatonTail entries={batonTail(inspect?.baton ?? [])} nowMs={nowMs} />
      <RunActions project={project} epicId={epicId} run={run} live={view.live} onDone={refresh} />
      <ReadAge stale={readStale} fetchedAt={fetchedAt} nowMs={nowMs} />
    </div>
  )
}
