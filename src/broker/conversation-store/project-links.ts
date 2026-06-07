import type { ServerWebSocket } from 'bun'
import { cwdToProjectUri, extractProjectLabel, normalizeProjectUri } from '../../shared/project-uri'
import type { Conversation } from '../../shared/protocol'
import { getProjectSettings } from '../project-settings'

function toProjectUri(cwdOrUri: string): string {
  if (cwdOrUri.startsWith('/')) return cwdToProjectUri(cwdOrUri)
  return normalizeProjectUri(cwdOrUri)
}

function projectLinkKey(a: string, b: string): string {
  return [normalizeProjectUri(a), normalizeProjectUri(b)].sort().join('|')
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
): ProjectLinkRegistry {
  const projectLinks = new Set<string>()
  const projectBlocks = new Map<string, number>()
  const messageQueue = new Map<string, Array<Record<string, unknown>>>()
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
      const key = projectLinkKey(projFrom, projTo)
      const queue = messageQueue.get(key) || []
      queue.push(message)
      messageQueue.set(key, queue)
    },

    drainProjectMessages(from, to) {
      const projFrom = conversationToProject(from)
      const projTo = conversationToProject(to)
      if (!projFrom || !projTo) return []
      const key = projectLinkKey(projFrom, projTo)
      const msgs = messageQueue.get(key) || []
      messageQueue.delete(key)
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
