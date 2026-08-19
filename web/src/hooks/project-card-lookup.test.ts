/**
 * @vitest-environment node
 */
import type { ProjectTaskManifestEntry } from '@shared/project-task-types'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const state = vi.hoisted(() => ({
  manifest: new Map<string, ProjectTaskManifestEntry>(),
  meta: new Map<string, unknown>(),
  manifestFetched: true,
  manifestFetchedAt: 0,
  manifestInflight: null as Promise<void> | null,
  fetchManifest: vi.fn(() => Promise.resolve()),
  queueHydration: vi.fn(),
  now: 1_700_000_000_000,
}))

vi.mock('./project-task-cache', () => ({
  cacheVersion: () => 1,
  installSharedHandler: () => {},
  refKey: (e: ProjectTaskManifestEntry) => e.slug,
  getProjectCache: () => state,
  fetchManifest: state.fetchManifest,
  queueHydration: state.queueHydration,
}))

const { ensureProjectCard, peekProjectCard } = await import('./project-card-lookup')

const URI = 'claude://studio/proj'

function haveCard(slug: string) {
  state.manifest.set(slug, { slug, status: 'open', mtime: 1 })
}

beforeEach(() => {
  state.manifest = new Map()
  state.meta = new Map()
  state.manifestFetched = true
  state.manifestFetchedAt = state.now
  state.manifestInflight = null
  state.fetchManifest.mockClear()
  state.queueHydration.mockClear()
  vi.spyOn(Date, 'now').mockReturnValue(state.now)
})

describe('ensureProjectCard', () => {
  it('fetches the manifest when it has never been fetched', () => {
    state.manifestFetched = false
    ensureProjectCard(URI, 'anything')
    expect(state.fetchManifest).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch when the card is already in the manifest', () => {
    haveCard('known')
    ensureProjectCard(URI, 'known')
    expect(state.fetchManifest).not.toHaveBeenCalled()
    expect(state.queueHydration).toHaveBeenCalledWith(state, ['known'])
  })

  // THE BUG (2026-08-17): a card created AFTER the manifest was fetched read as
  // "NOT ON THIS BOARD -- deleted, renamed, or a different project" forever. All
  // three asserted causes were wrong; the real one was a stale snapshot, and
  // nothing ever re-checked because `manifestFetched` was treated as proof.
  it('RE-FETCHES the manifest when the requested card is missing from a stale one', () => {
    state.manifestFetchedAt = state.now - 60_000
    ensureProjectCard(URI, 'card-created-a-minute-ago')
    expect(state.fetchManifest).toHaveBeenCalledTimes(1)
  })

  it('hydrates the card once the re-fetch reveals it', async () => {
    state.manifestFetchedAt = state.now - 60_000
    state.fetchManifest.mockImplementation(() => {
      haveCard('late-card')
      return Promise.resolve()
    })
    ensureProjectCard(URI, 'late-card')
    await vi.waitFor(() => expect(state.queueHydration).toHaveBeenCalledWith(state, ['late-card']))
  })

  it('does NOT stampede: a miss inside the cooldown re-fetches only once', () => {
    state.manifestFetchedAt = state.now - 60_000
    ensureProjectCard(URI, 'missing-a')
    state.manifestFetchedAt = state.now // the fetch landed
    ensureProjectCard(URI, 'missing-b')
    ensureProjectCard(URI, 'missing-c')
    expect(state.fetchManifest).toHaveBeenCalledTimes(1)
  })

  it('does not re-fetch while a fetch is already in flight', () => {
    state.manifestFetchedAt = state.now - 60_000
    state.manifestInflight = Promise.resolve()
    ensureProjectCard(URI, 'missing')
    expect(state.fetchManifest).not.toHaveBeenCalled()
  })
})

describe('peekProjectCard', () => {
  it('reports manifestFetched so a caller can tell "absent" from "not yet known"', () => {
    state.manifestFetched = false
    expect(peekProjectCard(URI, 'x').manifestFetched).toBe(false)
  })

  it('returns the entry when the manifest knows the slug', () => {
    haveCard('known')
    expect(peekProjectCard(URI, 'known').entry?.slug).toBe('known')
  })
})
