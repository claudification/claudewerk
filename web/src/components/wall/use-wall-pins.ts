/**
 * `useWallPins()` -- every pinned epic the fleet has, across every project.
 *
 * THE FEED IS THE BOARD ITSELF. The pin is `wall_pinned: true` in an epic card's
 * frontmatter (src/shared/wall-pin.ts), so this reads the SAME project-task cache
 * the board reads -- one manifest plus one coalesced `getBatch` per project, live
 * through `project_changed`. No second fetch path, and no new broker route: a pin
 * written by an agent with a text editor shows up here on the next push.
 *
 * IT USES THE WATCH-FREE READER. `useProjectTasks` arms a lease-bound sentinel
 * watch per project; doing that for every project in the fleet because a wall is
 * open would leave a dozen watches running. This subscribes to the caches
 * directly instead and lets whichever board is actually mounted own the watch.
 *
 * KNOWN COST, stated rather than hidden: finding the pin needs the card's
 * frontmatter, and only the full card carries it -- so this hydrates every
 * project's whole manifest. That is one batched round trip per project, the same
 * one the EPICS view already makes for the project you are looking at. If the
 * fleet grows past what that can carry, the fix is a sentinel-side `pinned` board
 * op that folds it before the wire, not a cap here.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import {
  cacheVersion,
  fetchManifest,
  getProjectCache,
  installSharedHandler,
  queueHydration,
  refKey,
  subscribeProjectCache,
} from '@/hooks/project-task-cache'
import { useConversationsStore } from '@/hooks/use-conversations'
import { projectDisplayName } from '@/lib/utils'
import { type PinnedEpicRow, pinnedEpicRows } from './pinned-epic-rows'

/** A pinned epic, plus how its project is meant to LOOK (the configured icon and
 *  colour, resolved once here rather than per row). */
export interface WallPinRow extends PinnedEpicRow {
  projectName: string
  projectIcon?: string
  projectColor?: string
}

/**
 * The projects the panel knows about, from the conversation registry -- the same
 * source Pulse and the board use. A project the panel has never seen a
 * conversation for is invisible to the whole wall, not just to this pane.
 */
function useKnownProjects(): string[] {
  const conversationsById = useConversationsStore(s => s.conversationsById)
  return useMemo(() => {
    const seen = new Set<string>()
    for (const conv of Object.values(conversationsById)) {
      if (conv.project) seen.add(conv.project)
    }
    return [...seen].sort()
  }, [conversationsById])
}

/** One number that changes whenever ANY of these project caches does. */
function useCacheVersion(projects: readonly string[]): number {
  // The joined list is the real identity of `projects`; the array itself is
  // rebuilt on every store churn, and a changing subscribe callback tears down
  // and re-adds every subscription each render.
  const key = projects.join('\n')

  const subscribe = useCallback(
    (onChange: () => void) => {
      const offs = key ? key.split('\n').map(p => subscribeProjectCache(p, onChange)) : []
      return () => {
        for (const off of offs) off()
      }
    },
    [key],
  )
  const snapshot = useCallback(
    () => (key ? key.split('\n').reduce((n, p) => n + cacheVersion(getProjectCache(p)), 0) : 0),
    [key],
  )

  return useSyncExternalStore(subscribe, snapshot, () => 0)
}

export function useWallPins(): WallPinRow[] {
  const projects = useKnownProjects()
  const projectSettings = useConversationsStore(s => s.projectSettings)
  const version = useCacheVersion(projects)

  useEffect(() => {
    installSharedHandler()
  }, [])

  // Manifest first, then hydrate whatever it named. Both are idempotent and
  // in-flight-guarded by the cache, so re-running on every version bump costs
  // nothing once a project has settled.
  useEffect(() => {
    for (const projectUri of projects) {
      const cache = getProjectCache(projectUri)
      if (!cache.manifestFetched && !cache.manifestInflight) {
        void fetchManifest(cache)
        continue
      }
      queueHydration(cache, [...cache.manifest.values()].map(refKey))
    }
  }, [projects, version])

  return useMemo(() => {
    const rows: WallPinRow[] = []
    for (const projectUri of projects) {
      const cache = getProjectCache(projectUri)
      const settings = projectSettings[projectIdentityKey(projectUri)]
      for (const row of pinnedEpicRows(projectUri, [...cache.meta.values()])) {
        rows.push({
          ...row,
          projectName: projectDisplayName(projectUri, settings?.label),
          projectIcon: settings?.icon,
          projectColor: settings?.color,
        })
      }
    }
    return rows.toSorted((a, b) => b.movedAt - a.movedAt)
    // `version` is the cache's change signal -- the Maps above are mutated in
    // place, so nothing else in this list would ever tell us they moved.
  }, [projects, projectSettings, version])
}
