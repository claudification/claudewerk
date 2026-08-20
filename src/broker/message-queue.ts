/**
 * Persistent message queue: stores messages for offline/disconnected conversations.
 *
 * Keyed by target project (not conversation ID) so messages survive
 * session restarts. Backed by StoreDriver.messages (SQLite).
 *
 * Two callers share this table, distinguished by what they put in `to_scope`:
 *   - the OFFLINE path (`ctx.messageQueue`, the module-level singleton below) --
 *     `to_scope` is a project URI, and the traffic is already authorized;
 *   - the PENDING-APPROVAL path (`conversation-store/project-links.ts`) --
 *     `to_scope` is a `pending-link:` pair key, and the traffic is NOT yet
 *     authorized. Those rows are addressable only by the pair key, so a target
 *     project's ordinary drain can never reach them. See `pendingLinkScope`.
 */

import type { MessageStore } from './store/types'

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000 // 24 hours
const MAX_QUEUE_PER_TARGET = 100

export interface DrainedMessage {
  ts: number
  senderProject: string
  senderName: string
  message: Record<string, unknown>
  targetName?: string
}

export interface MessageQueue {
  enqueue(
    targetScope: string,
    senderProject: string,
    senderName: string,
    message: Record<string, unknown>,
    targetName?: string,
  ): void
  drain(targetScope: string, conversationName?: string): DrainedMessage[]
  getQueueSize(targetScope: string): number
}

/**
 * Bind the queue operations to a store. Both the offline singleton and the
 * pending-approval registry go through this, so the TTL and the per-scope cap
 * are defined once.
 */
export function createMessageQueue(store: MessageStore): MessageQueue {
  return {
    enqueue(targetScope, senderProject, senderName, message, targetName) {
      // Cap queue size per target -- drop the single oldest message if at limit.
      // Replaces the O(n) dequeue-all + re-enqueue-n-1 pattern with one SQL DELETE.
      const count = store.countFor(targetScope)
      if (count >= MAX_QUEUE_PER_TARGET) {
        store.dropOldest(targetScope)
      }

      store.enqueue({
        fromScope: senderProject,
        toScope: targetScope,
        fromName: senderName,
        targetName,
        content: JSON.stringify(message),
        expiresAt: Date.now() + MESSAGE_TTL_MS,
      })
    },

    /**
     * Drain pending messages for a target scope.
     * If conversationName is provided, only drains messages targeted at that name
     * (or messages with no targetName -- project-level messages). Messages targeted
     * at other conversation names stay in the queue.
     */
    drain(targetScope, conversationName) {
      const messages = store.dequeueFor(targetScope, conversationName || undefined)
      return messages.map(m => ({
        ts: m.createdAt,
        senderProject: m.fromScope,
        senderName: m.fromName || m.fromScope,
        message: JSON.parse(m.content) as Record<string, unknown>,
        targetName: m.targetName,
      }))
    },

    getQueueSize(targetScope) {
      return store.countFor(targetScope)
    },
  }
}

// ─── Module-level singleton: the OFFLINE path (ctx.messageQueue) ───────────

let queue: MessageQueue | null = null

export function initMessageQueue(messageStore: MessageStore): void {
  queue = createMessageQueue(messageStore)
  messageStore.pruneExpired()
}

export function enqueue(
  targetProject: string,
  senderProject: string,
  senderName: string,
  message: Record<string, unknown>,
  targetName?: string,
): void {
  queue?.enqueue(targetProject, senderProject, senderName, message, targetName)
}

export function drain(targetProject: string, conversationName?: string): DrainedMessage[] {
  return queue?.drain(targetProject, conversationName) ?? []
}

export function getQueueSize(targetProject: string): number {
  return queue?.getQueueSize(targetProject) ?? 0
}
