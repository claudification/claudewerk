/**
 * ConversationTag - Clickable conversation name badge with hover tooltip showing project/status.
 * Shared by send_message (tool-line) and received inter-conversation messages (group-view).
 *
 * Resolution is server-authoritative: a local cache hit renders instantly, and
 * any miss is resolved against the broker (which alone knows in-window
 * former-slug aliases). So a pill addressing a conversation by a name it shed in
 * a rename ("shady-marlin" -> now "monday report") resolves to the CURRENT
 * conversation, renders its current name, and navigates -- instead of sitting
 * dead because the web couldn't match the old alias. See conversation-tag-resolve.ts.
 */

import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import {
  displayNameFor,
  projectPath,
  resolveLocalConversation,
  resolveRemoteConversation,
  stripProjectPrefix,
} from './conversation-tag-resolve'

function showToast(title: string, body: string, variant = 'warning') {
  window.dispatchEvent(new CustomEvent('rclaude-toast', { detail: { title, body, variant } }))
}

function buttonClass(navigable: boolean, isEnded: boolean, extra?: string) {
  return cn(
    'font-bold hover:underline',
    navigable ? 'cursor-pointer' : 'cursor-help',
    isEnded ? 'text-teal-400/50 hover:text-teal-400/70' : 'text-teal-400 hover:text-teal-300',
    !navigable && 'text-teal-400/40 hover:text-teal-400/60',
    extra,
  )
}

function TagTooltip({ conversation, rawAddress }: { conversation: Conversation | undefined; rawAddress: string }) {
  const status = conversation ? conversation.status : 'unknown'
  const isEnded = status === 'ended'
  const resolvedPath = conversation ? projectPath(conversation.project) : undefined
  const idLine = conversation ? conversation.id : rawAddress
  return (
    <span
      className={cn(
        'pointer-events-none absolute bottom-full left-0 mb-1.5 z-50',
        'hidden group-hover/stag:flex flex-col gap-0.5',
        'rounded border border-zinc-700 bg-zinc-900 px-2.5 py-1.5 shadow-lg',
        'text-[10px] font-mono whitespace-nowrap',
      )}
    >
      {resolvedPath ? <span className="text-zinc-300">{resolvedPath}</span> : null}
      <span className={cn('text-zinc-500', isEnded && 'text-zinc-600')}>{status}</span>
      <span className="text-zinc-600">
        <span className="text-zinc-700">@</span> {idLine}
      </span>
      {conversation ? null : <span className="text-amber-500/80">click to open</span>}
    </span>
  )
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
  const bare = stripProjectPrefix(safeIdOrSlug)

  const local = resolveLocalConversation(safeIdOrSlug, resolvedId)
  // Server-resolved fallback (alias-aware). Held in local state because the
  // display helper reads the store imperatively (not as a hook subscription),
  // so injecting alone wouldn't re-render this row.
  const [remote, setRemote] = useState<Conversation | undefined>()
  const conversation = local ?? remote

  // Auto-resolve a local miss against the broker once, so the pill shows the
  // CURRENT name and is clickable rather than a dead alias string.
  useEffect(() => {
    if (local || (!resolvedId && !bare)) return
    let alive = true
    resolveRemoteConversation(resolvedId, bare).then(conv => {
      if (alive && conv) setRemote(conv)
    })
    return () => {
      alive = false
    }
  }, [local, resolvedId, bare])

  const displayName = displayNameFor(conversation, bare)
  const isEnded = conversation?.status === 'ended'
  // Clickable whenever there is anything to navigate to -- a resolved
  // conversation, a resolved UUID, or a name the server can look up.
  const navigable = Boolean(conversation || resolvedId || bare)

  const openTaggedConversation = () => {
    haptic('tap')
    const select = (id: string) => useConversationsStore.getState().selectConversation(id)
    if (conversation) return select(conversation.id)
    resolveRemoteConversation(resolvedId, bare).then(conv => {
      if (conv) {
        setRemote(conv)
        select(conv.id)
      } else {
        haptic('error')
        showToast('Conversation not found', `Could not find conversation "${bare}" on the server.`)
      }
    })
  }

  return (
    <span className="relative group/stag inline-block">
      <button type="button" className={buttonClass(navigable, isEnded, className)} onClick={openTaggedConversation}>
        {displayName}
        {isEnded && <span className="ml-1 text-[9px] text-zinc-500 font-normal">(ended)</span>}
      </button>
      <TagTooltip conversation={conversation} rawAddress={safeIdOrSlug} />
    </span>
  )
}
