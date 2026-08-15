/**
 * The project board cache -- one entry per project URI, shared by every reader
 * (the board, the PLACE card counts, the card-link hover).
 *
 * Two tiers, deliberately: the MANIFEST is identity + mtime for every card (one
 * cheap round trip), and META is the full card, hydrated only for the cards a
 * caller is actually rendering, coalesced into one `getBatch` per microtask.
 *
 * React lives in `use-project-tasks.ts`; this file is plain state so non-hook
 * callers (the card provider) can read the same cache without a component.
 */

import type {
  ProjectTaskManifestEntry as ManifestEntry,
  ProjectTaskMeta,
  ProjectTaskRef as TaskRef,
} from '@shared/project-task-types'
import { installProjectHandler, sendBoardOp } from './project-task-wire'

export interface ProjectCache {
  projectUri: string
  manifest: Map<string, ManifestEntry>
  meta: Map<string, ProjectTaskMeta>
  /** Keys whose mtime advanced since last hydration -- next read should refetch. */
  staleMeta: Set<string>
  manifestFetched: boolean
  /** When the manifest last landed -- lets a watch-free reader decide it is stale. */
  manifestFetchedAt: number
  manifestInflight: Promise<void> | null
  hydrationInflight: Map<string, Promise<void>>
  hydrationQueue: Set<string>
  hydrationFlushScheduled: boolean
  subscribers: Set<() => void>
}

interface ProjectDiff {
  added: ManifestEntry[]
  removed: TaskRef[]
  modified: ManifestEntry[]
}

const projectCaches = new Map<string, ProjectCache>()
const cacheVersions = new WeakMap<ProjectCache, number>()

/**
 * A card's key is its SLUG. Status is card CONTENT, never identity: the sentinel
 * keys its diff by slug, so a lane move is one `modified` entry -- under the old
 * `<status>/<slug>` key that wrote the new lane and orphaned the old one, and the
 * card sat in BOTH lanes until the next full manifest fetch.
 */
export function refKey(ref: { slug: string }): string {
  return ref.slug
}

export function getProjectCache(projectUri: string): ProjectCache {
  const existing = projectCaches.get(projectUri)
  if (existing) return existing
  const cache: ProjectCache = {
    projectUri,
    manifest: new Map(),
    meta: new Map(),
    staleMeta: new Set(),
    manifestFetched: false,
    manifestFetchedAt: 0,
    manifestInflight: null,
    hydrationInflight: new Map(),
    hydrationQueue: new Set(),
    hydrationFlushScheduled: false,
    subscribers: new Set(),
  }
  projectCaches.set(projectUri, cache)
  return cache
}

export function cacheVersion(cache: ProjectCache): number {
  return cacheVersions.get(cache) ?? 0
}

function notify(cache: ProjectCache): void {
  cacheVersions.set(cache, cacheVersion(cache) + 1)
  for (const sub of cache.subscribers) sub()
}

export function subscribeProjectCache(projectUri: string, fn: () => void): () => void {
  const cache = getProjectCache(projectUri)
  cache.subscribers.add(fn)
  return () => cache.subscribers.delete(fn)
}

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

export function installSharedHandler(): void {
  installProjectHandler(msg => {
    const projectUri = msg.project as string | undefined
    if (!projectUri) return
    const cache = projectCaches.get(projectUri)
    if (!cache) return
    if (msg.diff) applyDiff(cache, msg.diff as ProjectDiff)
  })
}

export function fetchManifest(cache: ProjectCache): Promise<void> {
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
      cache.manifestFetchedAt = Date.now()
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

/** Refetch when the cached manifest is older than `maxAgeMs`. */
export function refreshManifestIfStale(projectUri: string, maxAgeMs: number): void {
  const cache = getProjectCache(projectUri)
  if (cache.manifestInflight) return
  if (cache.manifestFetched && Date.now() - cache.manifestFetchedAt < maxAgeMs) return
  fetchManifest(cache)
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

export function queueHydration(cache: ProjectCache, keys: string[]): void {
  let queued = false
  for (const k of keys) {
    if (cache.hydrationInflight.has(k)) continue
    if (cache.meta.has(k) && !cache.staleMeta.has(k)) continue
    if (!cache.manifest.has(k)) continue
    cache.hydrationQueue.add(k)
    queued = true
  }
  if (!queued) return
  if (cache.hydrationFlushScheduled) return
  cache.hydrationFlushScheduled = true
  queueMicrotask(() => flushHydration(cache))
}
