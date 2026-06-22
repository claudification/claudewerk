/**
 * Resolution helpers for <ConversationTag>.
 *
 * Split out of conversation-tag.tsx so the component stays a thin renderer and
 * all the "what conversation does this name/id point at" logic lives in one
 * place. The LOCAL path is a fast cache hit (already-known id or current title);
 * anything it misses defers to the SERVER, which is the single source of truth
 * for slug resolution (it alone knows in-window former-slug aliases). The web
 * never reimplements alias decay -- it asks the broker.
 */

import { projectIdentityKey } from '@shared/project-uri'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'

function slugify(s: string) {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 24) || 'project'
  )
}

/** Strip project prefix from address-book style slugs (e.g. "rclaude:dapper-pretzel" -> "dapper-pretzel"). */
export function stripProjectPrefix(slug: string): string {
  const colonIdx = slug.indexOf(':')
  return colonIdx >= 0 ? slug.slice(colonIdx + 1) : slug
}

/** Find a conversation matching a slug by its CURRENT title/project label (local cache hit only -- no aliases). */
function findConversationBySlug(slug: string) {
  const { conversationsById, projectSettings } = useConversationsStore.getState()
  const normalizedSlug = slug.toLowerCase()
  for (const s of selectConversations(conversationsById)) {
    const ps = projectSettings[projectIdentityKey(s.project)]
    if (ps?.label && slugify(ps.label) === normalizedSlug) return s
    if (s.title && slugify(s.title) === normalizedSlug) return s
    const dirname = extractProjectLabel(s.project)
    if (dirname && slugify(dirname) === normalizedSlug) return s
  }
  return undefined
}

/** Compute a human display name for a (possibly undefined) conversation, falling back to the raw slug. */
export function displayNameFor(conversation: Conversation | undefined, fallback: string): string {
  const { projectSettings } = useConversationsStore.getState()
  const projLabel = conversation?.project ? projectSettings[projectIdentityKey(conversation.project)]?.label : undefined
  const title = conversation?.title
  if (projLabel && title) return `${projLabel} :: ${title}`
  return title || projLabel || (conversation?.project ? extractProjectLabel(conversation.project) : '') || fallback
}

/** Resolve a conversation LOCALLY (cache hit): exact id, then resolvedId, then current-title slug. */
export function resolveLocalConversation(idOrSlug: string, fallbackId?: string): Conversation | undefined {
  const { conversationsById } = useConversationsStore.getState()
  const bare = stripProjectPrefix(idOrSlug)
  return (
    conversationsById[idOrSlug] ||
    conversationsById[bare] ||
    (fallbackId ? conversationsById[fallbackId] : undefined) ||
    findConversationBySlug(bare) ||
    findConversationBySlug(idOrSlug)
  )
}

export { projectPath }

/** Inject a fetched conversation overview into the store so it becomes navigable + locally resolvable. */
function injectConversation(overview: Record<string, unknown>): Conversation {
  const partial: Conversation = {
    id: overview.id as string,
    project: overview.project as string,
    model: overview.model as string,
    status: (overview.status as Conversation['status']) || 'ended',
    connectionIds: (overview.connectionIds as string[]) || [],
    startedAt: overview.startedAt as number,
    lastActivity: overview.lastActivity as number,
    eventCount: (overview.eventCount as number) || 0,
    activeSubagentCount: 0,
    totalSubagentCount: 0,
    subagents: [],
    taskCount: 0,
    pendingTaskCount: 0,
    activeTasks: [],
    pendingTasks: [],
    completedTaskCount: 0,
    completedTasks: [],
    archivedTaskCount: 0,
    archivedTasks: [],
    runningBgTaskCount: 0,
    bgTasks: [],
    monitors: [],
    runningMonitorCount: 0,
    teammates: [],
    summary: overview.summary as string | undefined,
    title: overview.title as string | undefined,
    agentName: overview.agentName as string | undefined,
  }
  useConversationsStore.setState(state => {
    if (state.conversationsById[partial.id]) return state
    // Lightweight placeholder in the index (source of truth); never the selected
    // conversation, so it stays slim-by-construction.
    return { conversationsById: { ...state.conversationsById, [partial.id]: partial } }
  })
  return partial
}

// Dedup concurrent + repeat resolves for the same target -- a transcript can hold
// many pills pointing at the same conversation, and React re-renders/strict-mode
// double-mounts must not each fire a fetch.
const inflight = new Map<string, Promise<Conversation | null>>()

/**
 * Resolve a conversation against the SERVER (the alias-aware authority): try the
 * resolved UUID first (exact), then the slug via /conversations/by-slug (which
 * shares the broker's former-slug alias resolver). On success the conversation is
 * injected into the store and returned. Deduped by target so it runs once.
 */
export function resolveRemoteConversation(resolvedId?: string, slug?: string): Promise<Conversation | null> {
  const key = `${resolvedId ?? ''}|${slug ?? ''}`
  const existing = inflight.get(key)
  if (existing) return existing
  const attempt = (async () => {
    const urls: string[] = []
    if (resolvedId) urls.push(`/conversations/${resolvedId}`)
    if (slug) urls.push(`/conversations/by-slug/${slug}`)
    for (const url of urls) {
      try {
        // priority-fallback fetch (try first URL, fall back to next); Promise.any would burn both
        // react-doctor-disable-next-line react-doctor/async-await-in-loop
        const res = await fetch(url)
        if (!res.ok) continue
        const data = await res.json()
        if (data?.id) return injectConversation(data)
      } catch {
        /* network error, try next */
      }
    }
    return null
  })()
  inflight.set(key, attempt)
  // A failed resolve must not be cached forever -- drop the key so an explicit
  // click (or a later mount once the target exists) can retry. Successes inject
  // into the store, so local resolution hits next time without a refetch.
  attempt.then(conv => {
    if (!conv) inflight.delete(key)
  })
  return attempt
}
