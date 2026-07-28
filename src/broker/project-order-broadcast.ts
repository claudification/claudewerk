/**
 * Advertising a project-order change to its owner.
 *
 * The order is per-user, so a change is only ever news to the user who made it
 * -- but it IS news to every OTHER device that user has open, which is the whole
 * point of advertising instead of waiting for a refetch. Sockets belonging to
 * anyone else are skipped entirely; they have their own row.
 *
 * The grant filter still runs per socket: a user's own tree can name a project
 * whose read grant was later revoked, and the sidebar must not leak it back.
 * (Both halves of this used to be copy-pasted into the REST route and the WS
 * handler -- it lives here once now.)
 */

import type { ProjectOrder } from '../shared/project-order-types'
import type { ConversationStore } from './conversation-store'
import { resolvePermissions, type UserGrant } from './permissions'
import { orderUserForSocket } from './project-order-owner'

interface OrderSocketData {
  userName?: string
  grants?: UserGrant[]
}

/** Drop every node the grants cannot read. Groups survive only if a readable
 *  child survives. Null grants = admin = no filtering. */
export function filterProjectOrderTree(nodes: ProjectOrder['tree'], grants: UserGrant[]): ProjectOrder['tree'] {
  const result: ProjectOrder['tree'] = []
  for (const node of nodes) {
    if (node.type === 'project') {
      const { permissions } = resolvePermissions(grants, node.id)
      if (permissions.has('chat:read')) result.push(node)
    } else {
      const children = filterProjectOrderTree(node.children, grants)
      if (children.length > 0) result.push({ ...node, children })
    }
  }
  return result
}

/** The view of an order a holder of these grants is allowed to see. */
export function scopeOrderToGrants(order: ProjectOrder, grants: UserGrant[] | null | undefined): ProjectOrder {
  if (!grants) return order // admin
  return { ...order, tree: filterProjectOrderTree(order.tree, grants) }
}

/** Push a changed order to every socket of the user who owns it. */
export function advertiseProjectOrder(conversationStore: ConversationStore, user: string, order: ProjectOrder): void {
  for (const ws of conversationStore.getSubscribers()) {
    const data = ws.data as OrderSocketData
    if (orderUserForSocket(data.userName) !== user) continue
    try {
      ws.send(JSON.stringify({ type: 'project_order_updated', order: scopeOrderToGrants(order, data.grants) }))
    } catch {
      /* dead socket */
    }
  }
}
