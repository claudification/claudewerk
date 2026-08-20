/**
 * `useUnattendedRuns()` -- what is running WITHOUT you, across every project.
 *
 * TWO FEEDS, BOTH ALREADY EXISTING, NEITHER A NEW ROUTE:
 *
 *  - EPIC RUNS come off `use-overseer-activity`, which the header badge already
 *    primes once over `POST /api/epic {op:'active'}` and then keeps current from
 *    the `epic_activity` push. That summary is deliberately cheap (no plan, no
 *    baton) because it feeds a permanently visible badge, so each ROW pays for
 *    its own `inspect` -- see `epic-run-row.tsx`.
 *
 *  - NIGHTSHIFT has no cross-project feed at all: every nightshift read is scoped
 *    to one project. So EXISTENCE is derived from the thing that is genuinely
 *    global, the conversation registry -- a night run exists while the registry
 *    holds any conversation tagged with it. That keeps the pane quiet with no
 *    fetch when nothing runs, and only the projects that DO have a run pay for
 *    the per-project snapshot.
 *
 * EXISTENCE IS NOT LIVENESS, and this file only answers the first. Whether a row
 * is RUNNING is `run-liveness.ts`'s single call, made once over both feeds; a
 * second test in here is what let a paused run render as a live one.
 *
 * The list this returns is what the filter counts. Enrichment (buckets, baton,
 * task totals) happens inside the row, so a row can never remove itself after
 * the fact and make `{matched}/{total}` a lie.
 */

import type { EpicActivityEntry } from '@shared/protocol'
import { useCallback, useMemo } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectAllRuns, useOverseerActivityStore } from '@/hooks/use-overseer-activity'
import { useWallRevive } from '@/lib/wall/use-wall-revive'
import { useProjectLook } from '../use-project-look'
import { useWallClock } from '../use-wall-clock'

interface RowBase {
  /** React key + the wall's own row identity. */
  key: string
  project: string
  projectName: string
  projectIcon?: string
  projectColor?: string
}

export interface EpicRunRowData extends RowBase {
  kind: 'epic'
  epicId: string
  entry: EpicActivityEntry
}

export interface NightshiftRunRowData extends RowBase {
  kind: 'nightshift'
  runId: string
  /** Workers up right now, straight from the registry. The snapshot's own task
   *  counts arrive in the row; this is the number `run-liveness.ts` turns into
   *  RUNNING or EXPIRED. Zero is a legitimate value and means the latter. */
  liveWorkers: number
}

export type UnattendedRow = EpicRunRowData | NightshiftRunRowData

/**
 * The wall clock this pane's ages are measured against.
 *
 * FIVE SECONDS, not one. Every age on this pane is a stall measured in minutes,
 * so a per-second tick would re-render six rows sixty times a minute to move a
 * number that changes twelve times an hour. The clock is passed DOWN rather than
 * read inside each row so every age on the pane agrees with every other one.
 */
export function useRunClock(intervalMs = 5_000): number {
  return useWallClock(intervalMs)
}

interface NightRun {
  project: string
  runId: string
  liveWorkers: number
}

/**
 * Night runs the registry knows about, keyed by project + run id, WITH a count
 * of how many of their workers are still up.
 *
 * THIS HOOK NO LONGER JUDGES LIVENESS. It used to `continue` past every ended
 * conversation, which made `status !== 'ended'` a second, disagreeing liveness
 * test living inside a feed -- the defect `run-liveness.ts` exists to delete. A
 * run whose last worker exits now becomes `liveWorkers: 0` and is called EXPIRED
 * once, in one place, where the pane can dim it instead of vanishing it.
 *
 * THAT IS BOUNDED, and by the store rather than by a rule here: ended
 * conversations are NOT in `conversationsById` on load (they were 97.7% of the
 * boot payload). So a night run comes back as an expired row only if it expired
 * while this wall was open -- which is exactly the run you want told about --
 * and a reload does not resurrect last week's.
 */
function useNightRuns(): NightRun[] {
  const conversationsById = useConversationsStore(s => s.conversationsById)
  return useMemo(() => {
    const byRun = new Map<string, NightRun>()
    for (const conv of Object.values(conversationsById)) {
      const tag = conv.nightshift
      if (!tag || !conv.project) continue
      const key = `${conv.project} ${tag.runId}`
      const row = byRun.get(key) ?? { project: conv.project, runId: tag.runId, liveWorkers: 0 }
      if (conv.status !== 'ended') row.liveWorkers++
      byRun.set(key, row)
    }
    return [...byRun.values()]
  }, [conversationsById])
}

export interface UnattendedFeed {
  rows: UnattendedRow[]
  /** The epic half was primed on an earlier connection. Night runs come off the
   *  conversation registry, which re-syncs on its own. */
  stale: boolean
  /**
   * Re-read the epic half NOW. `epic_activity` already pushes after every op
   * that changes whether a run is live, so this is not how the pane normally
   * stays current -- it is for the surface that just CAUSED such a change and
   * should not have to wait for its own echo to come back around.
   *
   * Exposed here rather than reaching into the activity store from a pane, so
   * the pane stays ignorant of which of the two feeds a row came from.
   */
  reprime: () => void
}

export function useUnattendedRuns(): UnattendedFeed {
  const epics = useOverseerActivityStore(selectAllRuns)
  const prime = useOverseerActivityStore(s => s.prime)
  const nights = useNightRuns()
  const look = useProjectLook()

  // The one HTTP read, shared with the header badge and idempotent behind
  // `primed` -- a wall opened mid-run must not sit blank until the next sweep.
  // FORCED through the revive seam, because after a drop `primed` only means the
  // rows were true on a connection that no longer exists. No poll: with the
  // socket up `epic_activity` keeps this current for free.
  const reprime = useCallback(() => prime(true), [prime])
  const { stale } = useWallRevive('runs', reprime)

  const rows = useMemo(() => {
    const rows: UnattendedRow[] = []
    for (const entry of epics) {
      rows.push({
        kind: 'epic',
        key: `epic ${entry.project} ${entry.epicId}`,
        project: entry.project,
        epicId: entry.epicId,
        entry,
        ...look(entry.project),
      })
    }
    for (const night of nights) {
      rows.push({
        kind: 'nightshift',
        key: `night ${night.project} ${night.runId}`,
        project: night.project,
        runId: night.runId,
        liveWorkers: night.liveWorkers,
        ...look(night.project),
      })
    }
    return rows
  }, [epics, nights, look])

  return useMemo(() => ({ rows, stale, reprime }), [rows, stale, reprime])
}
