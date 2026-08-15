/**
 * Slug-addressed reads of the board cache, for callers that hold a card ID and
 * nothing else -- a `[card-id](.rclaude/project/cards/card-id.md)` link in a
 * transcript knows the id but not the lane.
 *
 * The cache is keyed by slug, so the manifest IS the slug index -- a lookup here
 * is a plain `Map.get`. (It used to be keyed by `<status>/<slug>`, which needed a
 * separate index memoized on the cache version; that key also duplicated a card
 * across two lanes on every move, so it is gone.)
 */

import type { ProjectTaskManifestEntry as ManifestEntry, ProjectTaskMeta } from '@shared/project-task-types'
import {
  cacheVersion,
  fetchManifest,
  getProjectCache,
  installSharedHandler,
  type ProjectCache,
  queueHydration,
  refKey,
} from './project-task-cache'

export interface ProjectCardLookup {
  /** False while the first manifest fetch is still out -- "not found" is not yet true. */
  manifestFetched: boolean
  entry?: ManifestEntry
  meta?: ProjectTaskMeta
}

export function peekProjectCard(projectUri: string, slug: string): ProjectCardLookup {
  const cache = getProjectCache(projectUri)
  const entry = cache.manifest.get(slug)
  return {
    manifestFetched: cache.manifestFetched,
    entry,
    meta: entry ? cache.meta.get(refKey(entry)) : undefined,
  }
}

/** Make sure the manifest is loaded and this one card's detail is on its way. */
export function ensureProjectCard(projectUri: string, slug: string): void {
  installSharedHandler()
  const cache = getProjectCache(projectUri)
  if (!cache.manifestFetched && !cache.manifestInflight) {
    fetchManifest(cache).then(() => queueHydrationForSlug(cache, slug))
    return
  }
  queueHydrationForSlug(cache, slug)
}

function queueHydrationForSlug(cache: ProjectCache, slug: string): void {
  if (cache.manifest.has(slug)) queueHydration(cache, [slug])
}

/**
 * Hydrate EVERY card on the board. Expensive by design and hover-triggered only:
 * an epic's progress is a fold over its children, and a child declares its
 * parent, so there is no cheaper question to ask.
 */
export function hydrateProjectBoard(projectUri: string): void {
  installSharedHandler()
  const cache = getProjectCache(projectUri)
  if (!cache.manifestFetched && !cache.manifestInflight) {
    fetchManifest(cache).then(() => queueHydration(cache, [...cache.manifest.keys()]))
    return
  }
  queueHydration(cache, [...cache.manifest.keys()])
}

/** Every hydrated card. Partial while a board hydration is still landing. */
export function peekProjectMeta(projectUri: string): ProjectTaskMeta[] {
  return [...getProjectCache(projectUri).meta.values()]
}

/** Bumps on every cache change -- a memo key for folds over the whole board. */
export function boardVersion(projectUri: string): number {
  return cacheVersion(getProjectCache(projectUri))
}

/** True once every manifest entry has its meta -- the epic rollup can be trusted. */
export function isBoardHydrated(projectUri: string): boolean {
  const cache = getProjectCache(projectUri)
  return cache.manifestFetched && cache.meta.size >= cache.manifest.size
}
