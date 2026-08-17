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
  /** A manifest fetch is in flight RIGHT NOW, so a miss is still provisional.
   *  Without this the hover asserts "not on this board" for the beat between
   *  asking again and being answered -- a wrong claim, just a briefer one. */
  refetching: boolean
  entry?: ManifestEntry
  meta?: ProjectTaskMeta
}

export function peekProjectCard(projectUri: string, slug: string): ProjectCardLookup {
  const cache = getProjectCache(projectUri)
  const entry = cache.manifest.get(slug)
  return {
    manifestFetched: cache.manifestFetched,
    refetching: cache.manifestInflight !== null,
    entry,
    meta: entry ? cache.meta.get(refKey(entry)) : undefined,
  }
}

/**
 * A manifest miss is only evidence of absence if the manifest is CURRENT. Older
 * than this and a miss means "my snapshot predates that card", so we re-ask.
 *
 * 10s is chosen against the failure it prevents, not against load: a card link
 * is hovered seconds after an agent writes the card, and the project watch is
 * only armed while a board view is open -- so a reader looking at a transcript
 * has no push channel at all and would otherwise never learn.
 */
const MANIFEST_STALE_MS = 10_000

/**
 * Make sure the manifest is loaded and this one card's detail is on its way.
 *
 * THE BUG THIS GUARDS (2026-08-17): a card created after the first manifest
 * fetch rendered as "NOT ON THIS BOARD -- deleted, renamed, or a different
 * project" for the rest of the page session. All three asserted causes were
 * wrong. `manifestFetched` was being read as proof of a complete board, and the
 * resolve path could not heal it because the hydration queue skips a slug the
 * manifest does not list -- so the miss fed itself.
 */
export function ensureProjectCard(projectUri: string, slug: string): void {
  installSharedHandler()
  const cache = getProjectCache(projectUri)
  if (cache.manifestInflight) return

  const missing = !cache.manifest.has(slug)
  const stale = Date.now() - cache.manifestFetchedAt > MANIFEST_STALE_MS
  if (!cache.manifestFetched || (missing && stale)) {
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
