import type { TaskStatus } from '@shared/task-statuses'
import { useEffect, useMemo } from 'react'
import { refreshManifestIfStale, useProjectTaskSnapshot } from './use-project-tasks'

/**
 * Board counts for the PLACE card -- open / in-progress / in-review at a glance,
 * WITHOUT arming a sentinel watch.
 *
 * `useProjectTasks` keeps a lease-bound watch alive for as long as it is
 * mounted, which is right for a board and wrong for a hover: running a pointer
 * down a project list would open one watch per project and leave them there.
 * This reads the same cache through the watch-free path and refreshes it on a
 * TTL instead of being pushed to.
 */

/** How stale a cached manifest may be before a hover pays for a refetch. */
const COUNTS_TTL_MS = 60_000

export type ProjectTaskCounts = Record<TaskStatus, number> & { total: number; loading: boolean }

export function useProjectTaskCounts(projectUri: string | null): ProjectTaskCounts {
  const api = useProjectTaskSnapshot(projectUri)

  useEffect(() => {
    if (projectUri) refreshManifestIfStale(projectUri, COUNTS_TTL_MS)
  }, [projectUri])

  return useMemo(() => {
    const byStatus = api.byStatus
    return {
      inbox: byStatus.inbox.length,
      open: byStatus.open.length,
      'in-progress': byStatus['in-progress'].length,
      'in-review': byStatus['in-review'].length,
      done: byStatus.done.length,
      archived: byStatus.archived.length,
      total: api.manifest.length,
      loading: api.loading,
    }
  }, [api])
}
