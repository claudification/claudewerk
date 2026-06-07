import { projectIdentityKey } from '@shared/project-uri'
/**
 * ConversationTag - Clickable conversation name badge with hover tooltip showing project/status.
 * Shared by send_message (tool-line) and received inter-conversation messages (group-view).
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { buildSlimIndexWithSelected } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { extractProjectLabel, projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

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
function stripProjectPrefix(slug: string): string {
  const colonIdx = slug.indexOf(':')
  return colonIdx >= 0 ? slug.slice(colonIdx + 1) : slug
}

/** Find a conversation matching an address book slug (best-effort client-side match). */
function findConversationBySlug(slug: string) {
  const { conversations, projectSettings } = useConversationsStore.getState()
  const normalizedSlug = slug.toLowerCase()
  for (const s of conversations) {
    const ps = projectSettings[projectIdentityKey(s.project)]
    if (ps?.label && slugify(ps.label) === normalizedSlug) return s
    if (s.title && slugify(s.title) === normalizedSlug) return s
    const dirname = extractProjectLabel(s.project)
    if (dirname && slugify(dirname) === normalizedSlug) return s
  }
  return undefined
}

/** Resolve a conversation by ID or slug and compute the display name. */
function resolveConversationDisplay(idOrSlug: string, fallbackId?: string) {
  const { conversationsById, projectSettings } = useConversationsStore.getState()
  const bare = stripProjectPrefix(idOrSlug)
  const conversation =
    conversationsById[idOrSlug] ||
    conversationsById[bare] ||
    (fallbackId ? conversationsById[fallbackId] : undefined) ||
    findConversationBySlug(bare) ||
    findConversationBySlug(idOrSlug)
  const projLabel = conversation?.project ? projectSettings[projectIdentityKey(conversation.project)]?.label : undefined
  const title = conversation?.title
  const displayName =
    projLabel && title
      ? `${projLabel} :: ${title}`
      : title || projLabel || (conversation?.project ? extractProjectLabel(conversation.project) : '') || bare
  return { conversation, projLabel, title, displayName }
}

function showToast(title: string, body: string, variant = 'warning') {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, variant } }))
}

/** Inject a fetched conversation overview into the Zustand store so it becomes navigable. */
function injectConversation(overview: Record<string, unknown>) {
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
    const conversations = [...state.conversations, partial]
    return {
      conversations,
      conversationsById: buildSlimIndexWithSelected(conversations, state.selectedConversationId),
    }
  })
  return partial.id
}

/** Try to fetch a conversation from the server by UUID or slug. Returns the conversation ID on success. */
async function fetchAndInjectConversation(resolvedId?: string, slug?: string): Promise<string | null> {
  const attempts: string[] = []
  if (resolvedId) attempts.push(`/conversations/${resolvedId}`)
  if (slug) attempts.push(`/conversations/by-slug/${slug}`)

  for (const url of attempts) {
    try {
      // priority-fallback fetch (try first URL, fall back to next); Promise.any would burn both
      // react-doctor-disable-next-line react-doctor/async-await-in-loop
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
}

interface ConversationTagProps {
  /** Conversation ID or slug to resolve */
  idOrSlug: string
  /** Resolved conversation UUID (from tool result) -- used as fallback when slug doesn't match */
  resolvedId?: string
  /** Text size class, defaults to text-xs */
  className?: string
}

export function ConversationTag({ idOrSlug, resolvedId, className }: ConversationTagProps) {
  // Defensive: idOrSlug originates from untyped wire/JSON data. A non-string
  // (e.g. an array from a multicast send_message `to`) would crash the whole
  // transcript on `.toLowerCase()`. Coerce to a string at the boundary.
  const safeIdOrSlug = typeof idOrSlug === 'string' ? idOrSlug : String(idOrSlug ?? '')
  const { conversation, displayName } = resolveConversationDisplay(safeIdOrSlug, resolvedId)
  const resolvedPath = conversation?.project ? projectPath(conversation.project) : undefined
  const status = conversation?.status
  const isEnded = status === 'ended'

  const openTaggedConversation = () => {
    if (conversation) {
      haptic('tap')
      useConversationsStore.getState().selectConversation(conversation.id)
      return
    }
    haptic('tap')
    const bare = stripProjectPrefix(safeIdOrSlug)
    fetchAndInjectConversation(resolvedId, bare).then(id => {
      if (id) {
        useConversationsStore.getState().selectConversation(id)
      } else {
        haptic('error')
        showToast('Conversation not found', `Could not find conversation "${bare}" on the server.`)
      }
    })
  }

  return (
    <span className="relative group/stag inline-block">
      <button
        type="button"
        className={cn(
          'font-bold hover:underline',
          conversation ? 'cursor-pointer' : 'cursor-help',
          isEnded ? 'text-teal-400/50 hover:text-teal-400/70' : 'text-teal-400 hover:text-teal-300',
          !conversation && 'text-teal-400/40 hover:text-teal-400/60',
          className,
        )}
        onClick={openTaggedConversation}
      >
        {displayName}
        {isEnded && <span className="ml-1 text-[9px] text-zinc-500 font-normal">(ended)</span>}
      </button>
      {/* Hover tooltip */}
      <span
        className={cn(
          'pointer-events-none absolute bottom-full left-0 mb-1.5 z-50',
          'hidden group-hover/stag:flex flex-col gap-0.5',
          'rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 shadow-lg',
          'text-[10px] font-mono whitespace-nowrap',
        )}
      >
        {resolvedPath && <span className="text-zinc-300">{resolvedPath}</span>}
        <span className={cn('text-zinc-500', isEnded && 'text-zinc-600')}>{status ?? 'unknown'}</span>
        {(conversation?.id ?? safeIdOrSlug) && (
          <span className="text-zinc-600">
            <span className="text-zinc-700">@</span> {conversation?.id ?? safeIdOrSlug}
          </span>
        )}
        {!conversation && <span className="text-amber-500/80">click to search server</span>}
      </span>
    </span>
  )
}
