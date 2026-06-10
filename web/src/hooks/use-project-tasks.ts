/**
 * useProjectTasks - project-keyed task cache with incremental updates.
 *
 * Project files live in `{projectRoot}/.rclaude/project/{status}/*.md`, read +
 * written THROUGH THE SENTINEL (not a live agent host), so the board works with
 * zero running conversations. The cache key is the project URI.
 *
 * Wire shape (dashboard <-> broker <-> sentinel):
 *   - project_board_request { op:'manifest'|'getBatch'|... , project, requestId }
 *       -> project_board_result { manifest | batch | tasks | task | note | ... }
 *   - project_subscribe / project_unsubscribe { project }
 *       -> broker arms/disarms a lease-bound sentinel watch
 *   - project_changed { project, diff, notes }  live push from the sentinel watch
 */

import type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { useEffect, useSyncExternalStore } from 'react'
import { useConversations, useConversationsStore } from './use-conversations'

export type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
export type { TaskStatus } from '@shared/task-statuses'

interface ProjectDiff {
  added: ManifestEntry[]
  removed: TaskRef[]
  modified: ManifestEntry[]
}

interface ProjectCache {
  projectUri: string
  manifest: Map<string, ManifestEntry>
  meta: Map<string, ProjectTaskMeta>
  /** Slugs whose mtime advanced since last hydration -- next read should refetch. */
  staleMeta: Set<string>
  manifestFetched: boolean
  manifestInflight: Promise<void> | null
  hydrationInflight: Map<string, Promise<void>>
  /** Pending hydration queue, flushed once per microtask. */
  hydrationQueue: Set<string>
  hydrationFlushScheduled: boolean
  subscribers: Set<() => void>
}

const REQUEST_TIMEOUT_MS = 12_000
const projectCaches = new Map<string, ProjectCache>()
const pendingRequests = new Map<
  string,
  {
    resolve: (data: Record<string, unknown>) => void
    reject: (err: Error) => void
    timeout: ReturnType<typeof setTimeout>
  }
>()
let handlerInstalled = false

/** Board op params (subset of the wire envelope the dashboard is allowed to set). */
export interface BoardOpParams {
  status?: TaskStatus
  slug?: string
  filterStatus?: TaskStatus
  refs?: TaskRef[]
  input?: { title?: string; body: string; priority?: 'low' | 'medium' | 'high'; tags?: string[] }
  patch?: { title?: string; body?: string; priority?: 'low' | 'medium' | 'high'; tags?: string[] }
  fromStatus?: TaskStatus
  toStatus?: TaskStatus
}

type BoardOp = 'list' | 'manifest' | 'get' | 'getBatch' | 'create' | 'update' | 'move' | 'delete'

function sendWire(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('project request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    useConversationsStore.getState().sendWsMessage({ ...payload, requestId })
  })
}

/** Send a board op for a project and resolve on the matching result. */
export function sendBoardOp(
  projectUri: string,
  op: BoardOp,
  params: BoardOpParams = {},
): Promise<Record<string, unknown>> {
  return sendWire({ type: 'project_board_request', project: projectUri, op, ...params })
}

/** Read a project-relative file through the sentinel (markdown viewer). */
export async function readProjectFile(
  projectUri: string,
  relPath: string,
  maxBytes?: number,
): Promise<{ ok: boolean; content?: string; truncated?: boolean; error?: string }> {
  const resp = await sendWire({ type: 'project_file_request', project: projectUri, relPath, maxBytes })
  return {
    ok: !!resp.ok,
    content: resp.content as string | undefined,
    truncated: resp.truncated as boolean | undefined,
    error: resp.error as string | undefined,
  }
}

function refKey(ref: { slug: string; status: TaskStatus }): string {
  return `${ref.status}/${ref.slug}`
}

function ensureCache(projectUri: string): ProjectCache {
  let cache = projectCaches.get(projectUri)
  if (!cache) {
    cache = {
      projectUri,
      manifest: new Map(),
      meta: new Map(),
      staleMeta: new Set(),
      manifestFetched: false,
      manifestInflight: null,
      hydrationInflight: new Map(),
      hydrationQueue: new Set(),
      hydrationFlushScheduled: false,
      subscribers: new Set(),
    }
    projectCaches.set(projectUri, cache)
  }
  return cache
}

function notify(cache: ProjectCache): void {
  cacheVersions.set(cache, (cacheVersions.get(cache) ?? 0) + 1)
  for (const sub of cache.subscribers) sub()
}

const cacheVersions = new WeakMap<ProjectCache, number>()
const snapshotCache = new WeakMap<ProjectCache, { version: number; api: ProjectTasksApi }>()

function applyDiff(cache: ProjectCache, diff: ProjectDiff): void {
  let touched = false
  for (const entry of diff.added) {
    cache.manifest.set(refKey(entry), entry)
    touched = true
  }
  for (const ref of diff.removed) {
    const k = refKey(ref)
    if (cache.manifest.delete(k)) touched = true
    cache.meta.delete(k)
    cache.staleMeta.delete(k)
  }
  for (const entry of diff.modified) {
    const k = refKey(entry)
    cache.manifest.set(k, entry)
    if (cache.meta.has(k)) cache.staleMeta.add(k)
    touched = true
  }
  if (touched) notify(cache)
}

function installSharedHandler(): void {
  if (handlerInstalled) return
  handlerInstalled = true
  useConversationsStore.setState({
    projectHandler: (msg: Record<string, unknown>) => {
      // Live board push -- keyed by the project URI (sentinel-originated).
      if (msg.type === 'project_changed') {
        const projectUri = msg.project as string | undefined
        if (!projectUri) return
        const cache = projectCaches.get(projectUri)
        if (!cache) return
        if (msg.diff) applyDiff(cache, msg.diff as ProjectDiff)
        return
      }
      // Request/response replies (project_board_result, project_*_file_result).
      const requestId = msg.requestId as string | undefined
      if (requestId) {
        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingRequests.delete(requestId)
          if (msg.ok === false && msg.error) pending.reject(new Error(msg.error as string))
          else pending.resolve(msg)
        }
      }
    },
  })
}

async function fetchManifest(cache: ProjectCache): Promise<void> {
  if (cache.manifestInflight) return cache.manifestInflight
  const promise = (async () => {
    try {
      const resp = await sendBoardOp(cache.projectUri, 'manifest')
      const entries = (resp.manifest as ManifestEntry[]) || []
      const nextManifest = new Map<string, ManifestEntry>()
      for (const entry of entries) nextManifest.set(refKey(entry), entry)
      for (const k of cache.meta.keys()) {
        const fresh = nextManifest.get(k)
        if (!fresh) cache.meta.delete(k)
        else if (fresh.mtime !== cache.manifest.get(k)?.mtime) cache.staleMeta.add(k)
      }
      cache.manifest = nextManifest
      cache.manifestFetched = true
      notify(cache)
    } catch {
      // Leave manifestFetched=false; a later trigger (reconnect / project_changed) retries.
    } finally {
      cache.manifestInflight = null
    }
  })()
  cache.manifestInflight = promise
  return promise
}

function scheduleHydrationFlush(cache: ProjectCache): void {
  if (cache.hydrationFlushScheduled) return
  cache.hydrationFlushScheduled = true
  queueMicrotask(() => flushHydration(cache))
}

async function flushHydration(cache: ProjectCache): Promise<void> {
  cache.hydrationFlushScheduled = false
  if (cache.hydrationQueue.size === 0) return
  const refs: TaskRef[] = []
  const claimed: string[] = []
  for (const k of cache.hydrationQueue) {
    const entry = cache.manifest.get(k)
    if (!entry) continue
    refs.push({ slug: entry.slug, status: entry.status })
    claimed.push(k)
  }
  cache.hydrationQueue.clear()
  if (refs.length === 0) return
  const promise = sendBoardOp(cache.projectUri, 'getBatch', { refs }).then(resp => {
    const notes = (resp.batch as ProjectTaskMeta[]) || []
    for (const note of notes) {
      const k = refKey(note)
      cache.meta.set(k, note)
      cache.staleMeta.delete(k)
    }
    notify(cache)
  })
  for (const k of claimed) cache.hydrationInflight.set(k, promise)
  try {
    await promise
  } finally {
    for (const k of claimed) cache.hydrationInflight.delete(k)
  }
}

function queueHydration(cache: ProjectCache, keys: string[]): void {
  let queued = false
  for (const k of keys) {
    if (cache.hydrationInflight.has(k)) continue
    if (cache.meta.has(k) && !cache.staleMeta.has(k)) continue
    if (!cache.manifest.has(k)) continue
    cache.hydrationQueue.add(k)
    queued = true
  }
  if (queued) scheduleHydrationFlush(cache)
}

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

/**
 * Subscribe to a project's task cache. Returns the manifest synchronously
 * (empty until first fetch resolves) and a `hydrate(refs)` to lazily load full
 * meta for the entries the caller is actually rendering. While mounted it tells
 * the broker to keep a sentinel watch armed for live updates.
 */
export function useProjectTasks(projectUri: string | null): ProjectTasksApi {
  useEffect(() => {
    installSharedHandler()
  }, [])

  // Re-trigger fetch when connectivity changes (conversations list churns as
  // the WS (re)connects, unblocking a deferred manifest fetch).
  const conversations = useConversations()

  const snapshot = useSyncExternalStore<ProjectTasksApi>(
    onChange => {
      if (!projectUri) return () => {}
      const cache = ensureCache(projectUri)
      cache.subscribers.add(onChange)
      return () => cache.subscribers.delete(onChange)
    },
    () => {
      if (!projectUri) return EMPTY_API
      return buildSnapshot(ensureCache(projectUri))
    },
    () => EMPTY_API,
  )

  // Arm the lease-bound sentinel watch while this board is mounted.
  useEffect(() => {
    if (!projectUri) return
    const send = useConversationsStore.getState().sendWsMessage
    send({ type: 'project_subscribe', project: projectUri })
    return () => send({ type: 'project_unsubscribe', project: projectUri })
  }, [projectUri])

  // Kick off (or retry) the manifest fetch.
  useEffect(() => {
    if (!projectUri) return
    const cache = ensureCache(projectUri)
    if (!cache.manifestFetched && !cache.manifestInflight) fetchManifest(cache)
  }, [projectUri, conversations])

  return snapshot
}

function buildSnapshot(cache: ProjectCache): ProjectTasksApi {
  const version = cacheVersions.get(cache) ?? 0
  const cached = snapshotCache.get(cache)
  if (cached && cached.version === version) return cached.api
  const manifest = Array.from(cache.manifest.values()).sort((a, b) => b.mtime - a.mtime)
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
