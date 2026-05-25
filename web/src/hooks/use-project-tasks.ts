/**
 * useProjectTasks - project-keyed task cache with incremental updates.
 *
 * Replaces the per-conversation `useProject` fetch model. The data lives in
 * `{cwd}/.rclaude/project/{status}/*.md` which is project-scoped, not
 * conversation-scoped -- so the cache key is the project URI and all
 * conversations within the same project share one cache entry.
 *
 * Wire shape (see .claude/docs/plan-project-tasks-incremental.md):
 *   - project_manifest       cheap full-set fetch (readdir + stat, no parse)
 *   - project_get { refs }   batched lazy hydration
 *   - project_changed { diff } authoritative push from the agent host watcher
 *
 * Routing: any live conversation in the project is a valid wire endpoint.
 * The agent host reads `ctx.cwd`; conversations in the same project all
 * point at the same filesystem.
 */
import { useEffect, useSyncExternalStore } from 'react'
import type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
import type { TaskStatus } from '@shared/task-statuses'
import { useConversationsStore } from './use-conversations'

export type { TaskStatus } from '@shared/task-statuses'
export type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'

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

const REQUEST_TIMEOUT_MS = 10_000
const projectCaches = new Map<string, ProjectCache>()
const pendingRequests = new Map<
  string,
  { resolve: (data: Record<string, unknown>) => void; reject: (err: Error) => void; timeout: ReturnType<typeof setTimeout> }
>()
let handlerInstalled = false

/**
 * Send a request and resolve on the matching requestId reply. Used by both
 * the manifest/get cache path AND the legacy mutation shim (project_create
 * etc.) so they share one pending-request map -- one source of truth for
 * dispatching `*_response` messages.
 */
export function sendProjectRequest(
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return sendRequest(conversationId, payload)
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

/**
 * Pick any live (or best-available) conversation in the project to route the
 * request through. The agent host reads from ctx.cwd, so any conv in the
 * same project resolves to the same files.
 */
function pickConversationForProject(projectUri: string): string | null {
  const state = useConversationsStore.getState()
  const candidates = state.conversations.filter(c => c.project === projectUri)
  if (candidates.length === 0) return null
  // Prefer active > idle > starting > ended; tiebreak by lastActivity desc.
  const priority: Record<string, number> = { active: 0, idle: 1, starting: 2, ended: 3 }
  candidates.sort(
    (a, b) =>
      (priority[a.status] ?? 9) - (priority[b.status] ?? 9) || (b.lastActivity ?? 0) - (a.lastActivity ?? 0),
  )
  return candidates[0]?.id ?? null
}

function sendRequest(
  conversationId: string,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const requestId = crypto.randomUUID()
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pendingRequests.delete(requestId)
      reject(new Error('Request timed out'))
    }, REQUEST_TIMEOUT_MS)
    pendingRequests.set(requestId, { resolve, reject, timeout })
    useConversationsStore.getState().sendWsMessage({ ...payload, requestId, conversationId })
  })
}

function applyDiff(cache: ProjectCache, diff: ProjectDiff): void {
  let touched = false
  for (const entry of diff.added) {
    const k = refKey(entry)
    cache.manifest.set(k, entry)
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
      // project_changed broadcast -- apply diff to the originating project's cache.
      if (msg.type === 'project_changed') {
        const conversationId = msg.conversationId as string | undefined
        if (!conversationId) return
        const conv = useConversationsStore.getState().conversationsById[conversationId]
        const projectUri = conv?.project
        if (!projectUri) return
        const cache = projectCaches.get(projectUri)
        if (!cache) return
        if (msg.diff) {
          applyDiff(cache, msg.diff as ProjectDiff)
        }
        return
      }
      // Request-response replies.
      const requestId = msg.requestId as string | undefined
      if (requestId) {
        const pending = pendingRequests.get(requestId)
        if (pending) {
          clearTimeout(pending.timeout)
          pendingRequests.delete(requestId)
          if (msg.error) pending.reject(new Error(msg.error as string))
          else pending.resolve(msg)
        }
      }
    },
  })
}

async function fetchManifest(cache: ProjectCache): Promise<void> {
  if (cache.manifestInflight) return cache.manifestInflight
  const conversationId = pickConversationForProject(cache.projectUri)
  if (!conversationId) return // no live conversation yet; defer
  const promise = (async () => {
    try {
      const resp = await sendRequest(conversationId, { type: 'project_manifest' })
      const entries = (resp.entries as ManifestEntry[]) || []
      const nextManifest = new Map<string, ManifestEntry>()
      for (const entry of entries) nextManifest.set(refKey(entry), entry)
      // Evict meta entries that no longer exist, mark mtime-bumped ones stale.
      for (const k of cache.meta.keys()) {
        const fresh = nextManifest.get(k)
        if (!fresh) cache.meta.delete(k)
        else if (fresh.mtime !== cache.manifest.get(k)?.mtime) cache.staleMeta.add(k)
      }
      cache.manifest = nextManifest
      cache.manifestFetched = true
      notify(cache)
    } catch {
      // leave manifestFetched=false so a future call retries
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
  const conversationId = pickConversationForProject(cache.projectUri)
  if (!conversationId) return
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
  const promise = sendRequest(conversationId, { type: 'project_get', refs }).then(resp => {
    const notes = (resp.notes as ProjectTaskMeta[]) || []
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
  byStatus: {
    inbox: [],
    open: [],
    'in-progress': [],
    'in-review': [],
    done: [],
    archived: [],
  },
  getMeta: () => undefined,
  hydrate: () => {},
  loading: false,
}

/**
 * Subscribe to a project's task cache. Returns the manifest synchronously
 * (empty until first fetch resolves) and a `hydrate(refs)` to lazily load
 * full meta for the entries the caller is actually rendering.
 */
export function useProjectTasks(projectUri: string | null): ProjectTasksApi {
  useEffect(() => {
    installSharedHandler()
  }, [])

  // Re-fetch on conversation list changes (a new conversation arriving in
  // this project unblocks deferred manifest fetches).
  const conversations = useConversationsStore(s => s.conversations)

  const snapshot = useSyncExternalStore<ProjectTasksApi>(
    onChange => {
      if (!projectUri) return () => {}
      const cache = ensureCache(projectUri)
      cache.subscribers.add(onChange)
      return () => cache.subscribers.delete(onChange)
    },
    () => {
      if (!projectUri) return EMPTY_API
      const cache = ensureCache(projectUri)
      return buildSnapshot(cache)
    },
    () => EMPTY_API,
  )

  // Kick off manifest fetch as soon as we have a conversation to route through.
  useEffect(() => {
    if (!projectUri) return
    const cache = ensureCache(projectUri)
    if (!cache.manifestFetched && !cache.manifestInflight) {
      fetchManifest(cache)
    }
  }, [projectUri, conversations])

  return snapshot
}

function buildSnapshot(cache: ProjectCache): ProjectTasksApi {
  // Memoize per cache+version so referential identity is stable between renders.
  // notify() bumps the version; getSnapshot returns the same object until a
  // mutation invalidates it.
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
    hydrate: refs => {
      const keys = refs.map(refKey)
      queueHydration(cache, keys)
    },
    loading: !cache.manifestFetched,
  }
  snapshotCache.set(cache, { version, api })
  return api
}

