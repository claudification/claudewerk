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
 *    global, the conversation registry -- a night run is running exactly when it
 *    has a worker up. That keeps the pane quiet with no fetch when nothing runs,
 *    and only the projects that DO have a run pay for the per-project snapshot.
 *
 * The list this returns is what the filter counts. Enrichment (buckets, baton,
 * task totals) happens inside the row, so a row can never remove itself after
 * the fact and make `{matched}/{total}` a lie.
 */

import { projectIdentityKey } from '@shared/project-uri'
import type { EpicActivityEntry } from '@shared/protocol'
import { useEffect, useMemo, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectAllRuns, useOverseerActivityStore } from '@/hooks/use-overseer-activity'
import { projectDisplayName } from '@/lib/utils'
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
   *  counts arrive in the row; this is what makes the row EXIST. */
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

interface ProjectLook {
  projectName: string
  projectIcon?: string
  projectColor?: string
}

/** How a project is meant to LOOK, resolved once per project rather than per row. */
function useProjectLook(): (uri: string) => ProjectLook {
  const projectSettings = useConversationsStore(s => s.projectSettings)
  return useMemo(() => {
    const cache = new Map<string, ProjectLook>()
    return (uri: string) => {
      const hit = cache.get(uri)
      if (hit) return hit
      const settings = projectSettings[projectIdentityKey(uri)]
      const look: ProjectLook = {
        projectName: projectDisplayName(uri, settings?.label),
        ...(settings?.icon ? { projectIcon: settings.icon } : {}),
        ...(settings?.color ? { projectColor: settings.color } : {}),
      }
      cache.set(uri, look)
      return look
    }
  }, [projectSettings])
}

/**
 * Night runs with a worker still up, keyed by project + run id.
 *
 * `status !== 'ended'` is the liveness test: a night run whose workers have all
 * finished is last night's report, and last night's report belongs on the
 * nightshift screen, not on a pane about what is running unattended NOW.
 */
function useLiveNightRuns(): { project: string; runId: string; liveWorkers: number }[] {
  const conversationsById = useConversationsStore(s => s.conversationsById)
  return useMemo(() => {
    const byRun = new Map<string, { project: string; runId: string; liveWorkers: number }>()
    for (const conv of Object.values(conversationsById)) {
      const tag = conv.nightshift
      if (!tag || !conv.project || conv.status === 'ended') continue
      const key = `${conv.project} ${tag.runId}`
      const row = byRun.get(key)
      if (row) row.liveWorkers++
      else byRun.set(key, { project: conv.project, runId: tag.runId, liveWorkers: 1 })
    }
    return [...byRun.values()]
  }, [conversationsById])
}

export function useUnattendedRuns(): UnattendedRow[] {
  const epics = useOverseerActivityStore(selectAllRuns)
  const prime = useOverseerActivityStore(s => s.prime)
  const nights = useLiveNightRuns()
  const look = useProjectLook()

  // The one HTTP read, shared with the header badge and idempotent behind
  // `primed` -- a wall opened mid-run must not sit blank until the next sweep.
  useEffect(() => {
    void prime()
  }, [prime])

  return useMemo(() => {
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
}
