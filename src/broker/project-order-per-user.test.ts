/**
 * The sidebar order is PER USER: tree, groups, workspaces, the lot.
 *
 * Before 2026-07-28 a single shared `project-order` row backed every user, so
 * lisa reordering her sidebar rearranged jonas's. That row survives as a
 * read-only SEED -- a user who has never saved starts from it, then forks on
 * first write and never touches it again.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { getProjectOrder, initProjectOrder, setProjectOrder } from './project-order'
import type { KVStore } from './store/types'

function makeKv(rows: Record<string, unknown> = {}): KVStore & { rows: Map<string, unknown> } {
  const map = new Map<string, unknown>(Object.entries(rows))
  return {
    rows: map,
    get: <T = unknown>(key: string) => (map.get(key) ?? null) as T | null,
    set: (key, value) => void map.set(key, value),
    delete: key => map.delete(key),
    keys: prefix => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
  }
}

const PROJ_A = 'claude://default/Users/jonas/projects/alpha'
const PROJ_B = 'claude://default/Users/jonas/projects/beta'

const SHARED_SEED = {
  tree: [
    { id: PROJ_A, type: 'project' },
    { id: PROJ_B, type: 'project' },
  ],
  workspaces: [{ id: 'ws-1', name: 'Shared', color: 'emerald' }],
  workspaceTrees: { 'ws-1': [{ id: PROJ_A, type: 'project' }] },
}

describe('per-user project order', () => {
  let kv: ReturnType<typeof makeKv>

  beforeEach(() => {
    kv = makeKv({ 'project-order': structuredClone(SHARED_SEED) })
    initProjectOrder(kv)
  })

  test('a user with no row of their own starts from the shared seed', () => {
    expect(getProjectOrder('lisa').tree).toHaveLength(2)
    expect(getProjectOrder('lisa').workspaces).toEqual([{ id: 'ws-1', name: 'Shared', color: 'emerald' }])
  })

  test('reading does not fork -- the seed stays the only row until a write', () => {
    getProjectOrder('lisa')
    expect([...kv.rows.keys()]).toEqual(['project-order'])
  })

  test('a write forks into that user own row and leaves the seed untouched', () => {
    setProjectOrder('lisa', { tree: [{ id: PROJ_B, type: 'project' }] })

    expect(kv.rows.has('project-order:lisa')).toBe(true)
    expect(kv.get<{ tree: unknown[] }>('project-order')).toEqual(structuredClone(SHARED_SEED))
  })

  test("one user's edits never touch another user's order", () => {
    setProjectOrder('lisa', {
      tree: [{ id: PROJ_B, type: 'project' }],
      workspaces: [{ id: 'ws-lisa', name: 'Lisa only' }],
      workspaceTrees: { 'ws-lisa': [{ id: PROJ_B, type: 'project' }] },
    })

    // jonas still reads the seed -- lisa's workspace is invisible to him.
    expect(getProjectOrder('jonas').workspaces).toEqual([{ id: 'ws-1', name: 'Shared', color: 'emerald' }])
    expect(getProjectOrder('lisa').workspaces).toEqual([{ id: 'ws-lisa', name: 'Lisa only' }])
  })

  test('both users can hold different workspaces at the same time', () => {
    setProjectOrder('jonas', { tree: [{ id: PROJ_A, type: 'project' }], workspaces: [{ id: 'w-j', name: 'J' }] })
    setProjectOrder('lisa', { tree: [{ id: PROJ_B, type: 'project' }], workspaces: [{ id: 'w-l', name: 'L' }] })

    expect(getProjectOrder('jonas').workspaces?.[0]?.name).toBe('J')
    expect(getProjectOrder('lisa').workspaces?.[0]?.name).toBe('L')
    expect(kv.rows.has('project-order:jonas')).toBe(true)
    expect(kv.rows.has('project-order:lisa')).toBe(true)
  })

  test('a forked row survives a broker restart', () => {
    setProjectOrder('lisa', { tree: [{ id: PROJ_B, type: 'project' }], workspaces: [{ id: 'w-l', name: 'L' }] })

    initProjectOrder(kv) // fresh process, same storage
    expect(getProjectOrder('lisa').workspaces?.[0]?.name).toBe('L')
    expect(getProjectOrder('jonas').workspaces?.[0]?.name).toBe('Shared')
  })

  test('a user reading with no seed row at all gets an empty tree, not a throw', () => {
    initProjectOrder(makeKv())
    expect(getProjectOrder('nobody')).toEqual({ tree: [] })
  })
})
