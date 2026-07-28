/**
 * Regression: a save that omits the workspace fields must NOT delete them.
 *
 * The wipe (2026-07-28): three control-panel paths -- "Move to group",
 * "Rename group", and the Organize Projects modal -- build a fresh
 * `{ tree }` object and post it. `setProjectOrder` was a wholesale replace,
 * so every one of those group operations silently deleted `workspaces` and
 * `workspaceTrees` for EVERY user. Jonas lost his whole workspace set; it was
 * absent from every retained backup, so there was nothing to restore.
 *
 * The rule these tests pin: omitted means "unchanged", explicit-empty means
 * "delete". A writer that doesn't know about a field can never destroy it.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { getProjectOrder, initProjectOrder, setProjectOrder } from './project-order'
import type { KVStore } from './store/types'

function makeKv(seed?: Record<string, unknown>): KVStore {
  const map = new Map<string, unknown>()
  if (seed) map.set('project-order', seed)
  return {
    get: <T = unknown>(key: string) => (map.get(key) ?? null) as T | null,
    set: (key, value) => void map.set(key, value),
    delete: key => map.delete(key),
    keys: prefix => [...map.keys()].filter(k => !prefix || k.startsWith(prefix)),
  }
}

// Canonical form (empty authority collapses to `default` via projectIdentityKey).
const USER = 'jonas'
const PROJ_A = 'claude://default/Users/jonas/projects/alpha'
const PROJ_B = 'claude://default/Users/jonas/projects/beta'

const SEEDED = {
  tree: [
    { id: PROJ_A, type: 'project' },
    { id: PROJ_B, type: 'project' },
  ],
  workspaces: [
    { id: 'ws-1', name: 'Work', color: 'emerald' },
    { id: 'ws-2', name: 'Side', color: 'blue' },
  ],
  workspaceTrees: {
    'ws-1': [{ id: PROJ_A, type: 'project' }],
    'ws-2': [{ id: PROJ_B, type: 'project' }],
  },
}

describe('setProjectOrder workspace preservation', () => {
  beforeEach(() => {
    initProjectOrder(makeKv(structuredClone(SEEDED)))
  })

  test('seed loads with its workspaces intact', () => {
    const order = getProjectOrder(USER)
    expect(order.workspaces).toHaveLength(2)
    expect(Object.keys(order.workspaceTrees ?? {})).toEqual(['ws-1', 'ws-2'])
  })

  test('a bare { tree } save keeps workspaces and workspaceTrees', () => {
    // Exactly what grouping-menu-items.tsx / project-list.tsx rename /
    // use-organize-draft.ts post: a rebuilt tree, no workspace fields.
    setProjectOrder(USER, {
      tree: [
        {
          id: 'group-1',
          type: 'group',
          name: 'Clients',
          children: [{ id: PROJ_A, type: 'project' }],
        },
        { id: PROJ_B, type: 'project' },
      ],
    })

    const order = getProjectOrder(USER)
    expect(order.tree).toHaveLength(2)
    expect(order.workspaces).toHaveLength(2)
    expect(order.workspaces?.map(w => w.name)).toEqual(['Work', 'Side'])
    expect(order.workspaceTrees).toEqual({
      'ws-1': [{ id: PROJ_A, type: 'project' }],
      'ws-2': [{ id: PROJ_B, type: 'project' }],
    })
  })

  test('the preserved workspaces survive a reload from the same kv', () => {
    const kv = makeKv(structuredClone(SEEDED))
    initProjectOrder(kv)
    setProjectOrder(USER, { tree: [{ id: PROJ_A, type: 'project' }] })

    // Fresh process, same storage.
    initProjectOrder(kv)
    expect(getProjectOrder(USER).workspaces).toHaveLength(2)
  })

  test('an explicit empty workspaces list still deletes them', () => {
    // Omission is "unchanged"; an explicit empty array is a real delete.
    setProjectOrder(USER, { tree: [{ id: PROJ_A, type: 'project' }], workspaces: [], workspaceTrees: {} })

    const order = getProjectOrder(USER)
    expect(order.workspaces).toBeUndefined()
    expect(order.workspaceTrees).toBeUndefined()
  })

  test('an explicit workspaces list replaces the old one', () => {
    setProjectOrder(USER, {
      tree: [{ id: PROJ_A, type: 'project' }],
      workspaces: [{ id: 'ws-3', name: 'Fresh' }],
      workspaceTrees: { 'ws-3': [{ id: PROJ_A, type: 'project' }] },
    })

    const order = getProjectOrder(USER)
    expect(order.workspaces).toEqual([{ id: 'ws-3', name: 'Fresh' }])
    expect(Object.keys(order.workspaceTrees ?? {})).toEqual(['ws-3'])
  })

  test('workspaceTrees entries for still-live workspaces survive a tree-only save', () => {
    // The tree edit renames a group and drops a project from the global tree.
    // Workspace membership is a separate axis and must not follow it.
    setProjectOrder(USER, { tree: [{ id: PROJ_A, type: 'project' }] })
    expect(getProjectOrder(USER).workspaceTrees?.['ws-2']).toEqual([{ id: PROJ_B, type: 'project' }])
  })
})
