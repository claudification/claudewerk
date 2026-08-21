import type { ServerWebSocket } from 'bun'
import { cwdToProjectUri, extractProjectLabel, normalizeProjectUri } from '../../shared/project-uri'
import type { Conversation } from '../../shared/protocol'
import { createMessageQueue, type MessageQueue } from '../message-queue'
import { getProjectSettings } from '../project-settings'
import type { MessageStore } from '../store/types'

function toProjectUri(cwdOrUri: string): string {
  if (cwdOrUri.startsWith('/')) return cwdToProjectUri(cwdOrUri)
  return normalizeProjectUri(cwdOrUri)
}

function projectLinkKey(a: string, b: string): string {
  return [normalizeProjectUri(a), normalizeProjectUri(b)].sort().join('|')
}

/** Namespace prefix for pending-approval rows in the shared `message_queue` table.
 *
 *  A pending first-contact body is stored at rest BEFORE the human authorizes the
 *  boundary crossing, so it must be addressable ONLY by the project pair -- never
 *  by the target project alone. Every other writer puts a normalized project URI in
 *  `to_scope`, and a normalized project URI is always `scheme://authority/path`
 *  (see `normalizeProjectUri`). This prefix has no `//` after its colon, so it can
 *  never equal one: the target's ordinary `dequeueFor(<project uri>)` cannot reach
 *  these rows. `pending-link-scope.test.ts` pins that. */
const PENDING_LINK_SCOPE_PREFIX = 'pending-link:'

/** The `to_scope` under which a pending first-contact message is stored. */
export function pendingLinkScope(projectA: string, projectB: string): string {
  return `${PENDING_LINK_SCOPE_PREFIX}${projectLinkKey(projectA, projectB)}`
}

/** True for a `to_scope` that holds UNAPPROVED content. Operator-facing listings of
 *  queue rows must exclude these -- the whole point is that the target cannot read a
 *  message before approving it. */
export function isPendingLinkScope(scope: string): boolean {
  return scope.startsWith(PENDING_LINK_SCOPE_PREFIX)
}

function convLinkKey(a: string, b: string): string {
  return [a, b].sort().join('|')
}

export interface ProjectLinkRegistry {
  checkProjectLink: (from: string, to: string) => 'linked' | 'blocked' | 'unknown'
  getLinkedProjects: (conversationId: string) => Array<{ project: string; name: string }>
  linkProjects: (a: string, b: string) => void
  unlinkProjects: (a: string, b: string) => void
  blockProject: (blocker: string, blocked: string) => void
  queueProjectMessage: (from: string, to: string, message: Record<string, unknown>) => void
  drainProjectMessages: (from: string, to: string) => Array<Record<string, unknown>>
  broadcastToConversationsForProject: (project: string, message: Record<string, unknown>) => number
  toProjectUri: (cwdOrUri: string) => string
  // Conversation-scoped links (narrower than project links -- exactly two conversations).
  checkConvLink: (from: string, to: string) => 'linked' | 'unknown'
  linkConversations: (a: string, b: string) => void
  unlinkConversations: (a: string, b: string) => void
  getLinkedConversations: (conversationId: string) => Array<{ conversationId: string; name: string }>
}

export function createProjectLinkRegistry(
  conversations: Map<string, Conversation>,
  conversationSockets: Map<string, Map<string, ServerWebSocket<unknown>>>,
  /** Backing store for the PENDING-APPROVAL queue. Supply it and a first-contact
   *  message survives a broker restart; omit it and the queue falls back to memory
   *  (test-only shape -- the broker always passes `store.messages`). */
  messageStore?: MessageStore,
): ProjectLinkRegistry {
  const projectLinks = new Set<string>()
  const projectBlocks = new Map<string, number>()
  // PENDING-APPROVAL queue -- a DIFFERENT queue from the offline one. Holds a
  // first-contact message while the human decides ALLOW/BLOCK, keyed by sorted
  // project pair. Durable when `messageStore` is supplied: rows go into the shared
  // `message_queue` table under a `pending-link:` scope, inheriting its 24h TTL and
  // per-scope cap. The offline queue is `ctx.messageQueue` (same table, keyed by
  // TARGET project, already-authorized traffic only). Conflating the two is a known
  // trap; docs/inter-session.md has the table.
  const pendingQueue: MessageQueue | null = messageStore ? createMessageQueue(messageStore) : null
  const pendingFallback = new Map<string, Array<Record<string, unknown>>>()
  // Conversation-pair links, keyed by sorted conv-id pair. In-memory cache; the
  // persisted source of truth lives in conversation-links.ts (ctx.convLinks).
  const convLinks = new Set<string>()

  function conversationToProject(conversationId: string): string | undefined {
    return conversations.get(conversationId)?.project
  }

  function conversationName(conversationId: string): string {
    const conv = conversations.get(conversationId)
    return conv?.title || conv?.agentName || conversationId.slice(0, 8)
  }

  return {
    checkProjectLink(from, to) {
      const projFrom = conversationToProject(from)
      const projTo = conversationToProject(to)
      if (!projFrom || !projTo) return 'unknown'
      const key = projectLinkKey(projFrom, projTo)
      if (projectLinks.has(key)) return 'linked'
      const blockTs = projectBlocks.get(key)
      if (blockTs && Date.now() - blockTs < 60_000) return 'blocked'
      if (blockTs) projectBlocks.delete(key)
      return 'unknown'
    },

    getLinkedProjects(conversationId) {
      const thisProject = conversationToProject(conversationId)
      if (!thisProject) return []
      const result: Array<{ project: string; name: string }> = []
      for (const key of projectLinks) {
        const [a, b] = key.split('|')
        const other = a === normalizeProjectUri(thisProject) ? b : b === normalizeProjectUri(thisProject) ? a : null
        if (!other) continue
        const conv = Array.from(conversations.values()).find(s => normalizeProjectUri(s.project) === other)
        const otherProject = conv?.project || other
        const name = getProjectSettings(otherProject)?.label || extractProjectLabel(otherProject)
        result.push({ project: otherProject, name })
      }
      return result
    },

    linkProjects(a, b) {
      const projA = conversationToProject(a) || toProjectUri(a)
      const projB = conversationToProject(b) || toProjectUri(b)
      if (!projA || !projB) return
      const key = projectLinkKey(projA, projB)
      projectLinks.add(key)
      projectBlocks.delete(key)
    },

    unlinkProjects(a, b) {
      const projA = conversationToProject(a) || toProjectUri(a)
      const projB = conversationToProject(b) || toProjectUri(b)
      if (projA && projB) projectLinks.delete(projectLinkKey(projA, projB))
    },

    // A DENY is a 60-second COOL-OFF and that is BY DESIGN, not an oversight -- do not
    // "fix" it into a persisted block list. `channelLinkResponse` already removes the
    // persisted link row on block, so there is nothing left to resurrect and the pair
    // correctly re-prompts after the window. A durable "operator A said no" carries
    // owner/expiry/audit questions that belong to multi-operator policy, not here
    // (card werk-multi-operator).
    blockProject(blocker, blocked) {
      const projA = conversationToProject(blocker)
      const projB = conversationToProject(blocked)
      if (!projA || !projB) return
      const key = projectLinkKey(projA, projB)
      projectLinks.delete(key)
      projectBlocks.set(key, Date.now())
    },

    queueProjectMessage(from, to, message) {
      const projFrom = conversationToProject(from)
      const projTo = conversationToProject(to)
      if (!projFrom || !projTo) return
      if (pendingQueue) {
        // Scope is the PAIR, not the target -- see PENDING_LINK_SCOPE_PREFIX.
        pendingQueue.enqueue(pendingLinkScope(projFrom, projTo), normalizeProjectUri(projFrom), '', message)
        return
      }
      const key = projectLinkKey(projFrom, projTo)
      const queue = pendingFallback.get(key) || []
      queue.push(message)
      pendingFallback.set(key, queue)
    },

    drainProjectMessages(from, to) {
      const projFrom = conversationToProject(from)
      const projTo = conversationToProject(to)
      if (!projFrom || !projTo) return []
      if (pendingQueue) {
        return pendingQueue.drain(pendingLinkScope(projFrom, projTo)).map(d => d.message)
      }
      const key = projectLinkKey(projFrom, projTo)
      const msgs = pendingFallback.get(key) || []
      pendingFallback.delete(key)
      return msgs
    },

    broadcastToConversationsForProject(projectOrCwd, message) {
      const project = toProjectUri(projectOrCwd)
      const json = JSON.stringify(message)
      let count = 0
      for (const [conversationId, conv] of conversations) {
        if (conv.project !== project) continue
        const wrappers = conversationSockets.get(conversationId)
        if (!wrappers) continue
        for (const ws of wrappers.values()) {
          try {
            ws.send(json)
            count++
          } catch {}
        }
      }
      return count
    },

    toProjectUri,

    checkConvLink(from, to) {
      return convLinks.has(convLinkKey(from, to)) ? 'linked' : 'unknown'
    },

    linkConversations(a, b) {
      if (!a || !b || a === b) return
      convLinks.add(convLinkKey(a, b))
    },

    unlinkConversations(a, b) {
      convLinks.delete(convLinkKey(a, b))
    },

    getLinkedConversations(conversationId) {
      const result: Array<{ conversationId: string; name: string }> = []
      for (const key of convLinks) {
        const [a, b] = key.split('|')
        const other = a === conversationId ? b : b === conversationId ? a : null
        if (!other) continue
        result.push({ conversationId: other, name: conversationName(other) })
      }
      return result
    },
  }
}
