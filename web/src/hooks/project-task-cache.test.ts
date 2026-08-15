/**
 * The board cache must hold ONE entry per card, whatever lane it is in.
 *
 * REGRESSION (2026-08-15): the cache keyed entries by `<status>/<slug>` while the
 * sentinel keys its diff by slug alone -- a lane move therefore arrived as a
 * single `modified` entry, which wrote the NEW lane's key and left the OLD one
 * behind. The card then rendered in both lanes until a full manifest refetch.
 * Seen live on the whatsapp-mqtt board: one ticket in `open` AND `in-progress`.
 */

import { beforeEach, describe, expect, it } from 'vitest'
import { fetchManifest, getProjectCache, installSharedHandler } from './project-task-cache'
import { useConversationsStore } from './use-conversations'

let projectSeq = 0
/** The cache is module-global, so every test gets a fresh project URI. */
const nextProject = () => `claude://default/Users/x/lane-${++projectSeq}`

interface Entry {
  slug: string
  status: string
  mtime: number
}

/** A wire that answers `manifest` with `entries` and nothing else. */
function installFakeWire(entries: Entry[]) {
  useConversationsStore.setState({
    conversations: [],
    conversationsById: {},
    sendWsMessage: (msg: Record<string, unknown>) => {
      if (msg.type !== 'project_board_request' || msg.op !== 'manifest') return
      const reply = { type: 'project_board_result', requestId: msg.requestId, manifest: entries }
      queueMicrotask(() => useConversationsStore.getState().projectHandler?.(reply))
    },
  } as unknown as ReturnType<typeof useConversationsStore.getState>)
}

/** Push a live sentinel diff, exactly as `project_changed` delivers it. */
function pushChanged(project: string, diff: { added?: Entry[]; removed?: Entry[]; modified?: Entry[] }) {
  useConversationsStore.getState().projectHandler?.({
    type: 'project_changed',
    project,
    diff: { added: [], removed: [], modified: [], ...diff },
  })
}

describe('project task cache -- lane moves', () => {
  beforeEach(() => {
    installSharedHandler()
  })

  it('keeps exactly one entry when a card changes lane', async () => {
    const project = nextProject()
    installFakeWire([{ slug: 'no-typecheck-in-build', status: 'open', mtime: 1 }])
    const cache = getProjectCache(project)
    await fetchManifest(cache)

    // The sentinel keys its diff by slug, so a lane change is ONE `modified`
    // entry -- never a removed + added pair.
    pushChanged(project, { modified: [{ slug: 'no-typecheck-in-build', status: 'in-progress', mtime: 2 }] })

    const entries = [...cache.manifest.values()].filter(e => e.slug === 'no-typecheck-in-build')
    expect(entries).toHaveLength(1)
    expect(entries[0]?.status).toBe('in-progress')
  })

  it('drops the meta of a card that leaves the board', async () => {
    const project = nextProject()
    installFakeWire([{ slug: 'gone', status: 'open', mtime: 1 }])
    const cache = getProjectCache(project)
    await fetchManifest(cache)

    pushChanged(project, { removed: [{ slug: 'gone', status: 'open', mtime: 1 }] })

    expect(cache.manifest.size).toBe(0)
  })

  it('marks a lane-moved card stale so its hydrated meta is refetched', async () => {
    const project = nextProject()
    installFakeWire([{ slug: 'card', status: 'open', mtime: 1 }])
    const cache = getProjectCache(project)
    await fetchManifest(cache)
    const key = [...cache.manifest.keys()][0] as string
    cache.meta.set(key, { slug: 'card', status: 'open' } as never)

    pushChanged(project, { modified: [{ slug: 'card', status: 'done', mtime: 2 }] })

    // Same key before and after the move -- the stale mark has to survive it.
    const moved = [...cache.manifest.keys()][0] as string
    expect(cache.staleMeta.has(moved)).toBe(true)
  })
})
