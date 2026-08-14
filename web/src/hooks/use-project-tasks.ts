/**
 * useProjectTasks - React face of the project board cache.
 *
 * Cards live at `{projectRoot}/.rclaude/project/cards/{id}.md` (lane in their
 * `status:` frontmatter), read + written THROUGH THE SENTINEL (not a live agent
 * host), so the board works with zero running conversations.
 *
 * The state itself lives in `project-task-cache.ts` and the transport in
 * `project-task-wire.ts`; this file is the snapshot projection plus the two
 * hooks. Non-React readers (the card-link provider) use `project-card-lookup.ts`
 * against the same cache -- never a second fetch path.
 */

import type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { useEffect, useSyncExternalStore } from 'react'
import {
  cacheVersion,
  fetchManifest,
  getProjectCache,
  installSharedHandler,
  type ProjectCache,
  queueHydration,
  refKey,
} from './project-task-cache'
import { sendProjectMessage } from './project-task-wire'
import { useConversations } from './use-conversations'

export type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
export type { TaskStatus } from '@shared/task-statuses'
export { refreshManifestIfStale } from './project-task-cache'
export { readProjectFile, sendBoardOp } from './project-task-wire'

export interface ProjectTasksApi {
  /** All manifest entries, sorted by mtime DESC. Empty until first fetch resolves. */
  readonly manifest: ManifestEntry[]
  /** Manifest grouped by status. */
  readonly byStatus: Record<TaskStatus, ManifestEntry[]>
  /** Synchronous meta read; returns undefined if not yet hydrated. */
  getMeta(ref: TaskRef): ProjectTaskMeta | undefined
  /** Queue a batch of refs for hydration (fire-and-forget; coalesced per microtask). */
  hydrate(refs: TaskRef[]): void
  /** True until first manifest fetch resolves. */
  loading: boolean
}

const EMPTY_API: ProjectTasksApi = {
  manifest: [],
  byStatus: { inbox: [], open: [], 'in-progress': [], 'in-review': [], done: [], archived: [] },
  getMeta: () => undefined,
  hydrate: () => {},
  loading: false,
}

const snapshotCache = new WeakMap<ProjectCache, { version: number; api: ProjectTasksApi }>()

function buildSnapshot(cache: ProjectCache): ProjectTasksApi {
  const version = cacheVersion(cache)
  const cached = snapshotCache.get(cache)
  if (cached && cached.version === version) return cached.api
  const manifest = [...cache.manifest.values()].sort((a, b) => b.mtime - a.mtime)
  const byStatus: Record<TaskStatus, ManifestEntry[]> = {
    inbox: [],
    open: [],
    'in-progress': [],
    'in-review': [],
    done: [],
    archived: [],
  }
  for (const entry of manifest) byStatus[entry.status].push(entry)
  const api: ProjectTasksApi = {
    manifest,
    byStatus,
    getMeta: ref => cache.meta.get(refKey(ref)),
    hydrate: refs => queueHydration(cache, refs.map(refKey)),
    loading: !cache.manifestFetched,
  }
  snapshotCache.set(cache, { version, api })
  return api
}

/**
 * Read a project's task cache WITHOUT arming anything on the sentinel.
 *
 * THE RULE: a mounted BOARD earns a watch; a HOVER does not. Hovering down a
 * project list with `useProjectTasks` would open a lease-bound sentinel watch
 * per project and leave them running, so every read-only surface (the PLACE
 * card's board counts) comes through here instead. Same cache, same fetch, one
 * effect less -- not a second code path.
 */
export function useProjectTaskSnapshot(projectUri: string | null): ProjectTasksApi {
  useEffect(() => {
    installSharedHandler()
  }, [])

  // Re-trigger fetch when connectivity changes (conversations list churns as
  // the WS (re)connects, unblocking a deferred manifest fetch).
  const conversations = useConversations()

  const snapshot = useSyncExternalStore<ProjectTasksApi>(
    onChange => {
      if (!projectUri) return () => {}
      const cache = getProjectCache(projectUri)
      cache.subscribers.add(onChange)
      return () => cache.subscribers.delete(onChange)
    },
    () => (projectUri ? buildSnapshot(getProjectCache(projectUri)) : EMPTY_API),
    () => EMPTY_API,
  )

  useEffect(() => {
    if (!projectUri) return
    const cache = getProjectCache(projectUri)
    if (!cache.manifestFetched && !cache.manifestInflight) fetchManifest(cache)
  }, [projectUri, conversations])

  return snapshot
}

/**
 * Subscribe to a project's task cache. Returns the manifest synchronously
 * (empty until first fetch resolves) and a `hydrate(refs)` to lazily load full
 * meta for the entries the caller is actually rendering. While mounted it tells
 * the broker to keep a sentinel watch armed for live updates.
 */
export function useProjectTasks(projectUri: string | null): ProjectTasksApi {
  useEffect(() => {
    if (!projectUri) return
    sendProjectMessage({ type: 'project_subscribe', project: projectUri })
    return () => sendProjectMessage({ type: 'project_unsubscribe', project: projectUri })
  }, [projectUri])

  return useProjectTaskSnapshot(projectUri)
}
