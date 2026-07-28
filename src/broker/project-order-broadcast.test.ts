/**
 * Advertising a per-user order change.
 *
 * Two things have to hold, and the old shared-row broadcast held neither once
 * the order went per user: the change reaches ALL of the owner's devices (so a
 * workspace made on the phone shows up on the desktop without a refetch), and
 * it reaches NOBODY else (their row is different data entirely).
 */

import { describe, expect, test } from 'bun:test'
import type { ConversationStore } from './conversation-store'
import type { UserGrant } from './permissions'
import { advertiseProjectOrder, filterProjectOrderTree } from './project-order-broadcast'

const PROJ_A = 'claude://default/Users/jonas/projects/alpha'
const PROJ_B = 'claude://default/Users/jonas/projects/beta'

const ORDER = {
  tree: [
    { id: PROJ_A, type: 'project' as const },
    { id: PROJ_B, type: 'project' as const },
  ],
  workspaces: [{ id: 'ws-1', name: 'Work' }],
}

interface FakeSocket {
  data: { userName?: string; grants?: UserGrant[] }
  sent: string[]
  send(json: string): void
}

function socket(userName?: string, grants?: UserGrant[]): FakeSocket {
  const sent: string[] = []
  return { data: { userName, grants }, sent, send: (json: string) => void sent.push(json) }
}

function storeOf(sockets: FakeSocket[]): ConversationStore {
  return { getSubscribers: () => sockets } as unknown as ConversationStore
}

describe('advertiseProjectOrder', () => {
  test('reaches every device of the owner', () => {
    const phone = socket('jonas')
    const desktop = socket('jonas')
    advertiseProjectOrder(storeOf([phone, desktop]), 'jonas', ORDER)

    for (const ws of [phone, desktop]) {
      expect(ws.sent).toHaveLength(1)
      const msg = JSON.parse(ws.sent[0] as string)
      expect(msg.type).toBe('project_order_updated')
      expect(msg.order.workspaces).toEqual([{ id: 'ws-1', name: 'Work' }])
    }
  })

  test('never reaches another user', () => {
    const jonas = socket('jonas')
    const lisa = socket('lisa')
    advertiseProjectOrder(storeOf([jonas, lisa]), 'jonas', ORDER)

    expect(jonas.sent).toHaveLength(1)
    expect(lisa.sent).toHaveLength(0)
  })

  test('a recipient only sees the projects their grants can read', () => {
    const readsAOnly: UserGrant[] = [{ scope: PROJ_A, permissions: ['chat:read'] }]
    const lisa = socket('lisa', readsAOnly)
    advertiseProjectOrder(storeOf([lisa]), 'lisa', ORDER)

    const msg = JSON.parse(lisa.sent[0] as string)
    expect(msg.order.tree).toEqual([{ id: PROJ_A, type: 'project' }])
  })

  test('a dead socket does not stop the rest of the fan-out', () => {
    const dead = socket('jonas')
    dead.send = () => {
      throw new Error('socket closed')
    }
    const alive = socket('jonas')
    advertiseProjectOrder(storeOf([dead, alive]), 'jonas', ORDER)

    expect(alive.sent).toHaveLength(1)
  })
})

describe('filterProjectOrderTree', () => {
  test('drops a group whose every child is unreadable', () => {
    const grants: UserGrant[] = [{ scope: PROJ_A, permissions: ['chat:read'] }]
    const tree = [
      { id: 'g1', type: 'group' as const, name: 'Hidden', children: [{ id: PROJ_B, type: 'project' as const }] },
      { id: 'g2', type: 'group' as const, name: 'Kept', children: [{ id: PROJ_A, type: 'project' as const }] },
    ]

    expect(filterProjectOrderTree(tree, grants).map(n => n.id)).toEqual(['g2'])
  })
})
