import { Plus } from 'lucide-react'
import { useEffect, useMemo, useRef } from 'react'

import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { computeSwitchSlots, usePinnedConversations } from '@/lib/conversation-pins'
import type { Conversation } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'

function label(c: Conversation): string {
  return c.title || c.agentName || c.id.slice(0, 8)
}

function dotClass(status: Conversation['status']): { color: string; pulse: boolean } {
  if (status === 'ended') return { color: 'var(--idle)', pulse: false }
  if (status === 'active' || status === 'booting') return { color: 'var(--active)', pulse: true }
  return { color: 'var(--idle)', pulse: false } // idle / starting
}

/**
 * Mobile quick-switch strip -- a slim, horizontally scrollable pill row of the
 * conversations you pinned (long-press a row in the slider) plus auto-filled
 * recent-active ones. Tap a pill to switch; tap the CURRENT pill to alt-tab back
 * to the previous conversation. Renders nothing on desktop (the parent gates it
 * with `lg:hidden`) or when there is nothing worth switching to.
 */
export function PinnedSwitchStrip() {
  const conversations = useConversations()
  const pinnedIds = usePinnedConversations(s => s.pinnedIds)
  const selectedId = useConversationsStore(s => s.selectedConversationId)

  // Track the previously-selected conversation so tapping the current pill can
  // alt-tab back to it.
  const prevRef = useRef<string | null>(null)
  const lastRef = useRef<string | null>(selectedId)
  useEffect(() => {
    if (selectedId !== lastRef.current) {
      prevRef.current = lastRef.current
      lastRef.current = selectedId
    }
  }, [selectedId])

  const slots = useMemo(() => computeSwitchSlots(conversations, pinnedIds), [conversations, pinnedIds])

  // Nothing to switch between (just the current conversation, or none) -> hide.
  if (slots.length <= 1) return null

  function switchTo(id: string) {
    const store = useConversationsStore.getState()
    if (id === selectedId) {
      // Alt-tab: re-tapping the active pill jumps back to the previous conv.
      const prev = prevRef.current
      if (prev && prev !== id && conversations.some(c => c.id === prev)) {
        haptic('tap')
        store.selectConversation(prev, 'pinned-strip-alt-tab')
      }
      return
    }
    haptic('tap')
    store.selectConversation(id, 'pinned-strip')
  }

  return (
    <div className="lg:hidden flex items-center gap-1 overflow-x-auto py-1 px-1 shrink-0 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {slots.map(c => {
        const active = c.id === selectedId
        const { color, pulse } = dotClass(c.status)
        return (
          <button
            key={c.id}
            type="button"
            onClick={() => switchTo(c.id)}
            title={label(c)}
            className={cn(
              'flex items-center gap-1.5 rounded-full pl-2 pr-2.5 py-1 text-xs whitespace-nowrap shrink-0 transition-colors border',
              active
                ? 'bg-primary/15 border-primary/40 text-foreground font-medium'
                : 'bg-muted/40 border-transparent text-muted-foreground hover:bg-muted/70',
            )}
          >
            <span
              className={cn('size-2 rounded-full shrink-0', pulse && 'animate-pulse')}
              style={{ backgroundColor: color }}
            />
            <span className="max-w-[120px] truncate">{label(c)}</span>
          </button>
        )
      })}
      <button
        type="button"
        onClick={() => useConversationsStore.getState().toggleSwitcher()}
        title="Find a conversation"
        className="flex items-center justify-center size-6 rounded-full shrink-0 text-muted-foreground hover:text-foreground hover:bg-muted/70 transition-colors"
      >
        <Plus className="size-3.5" />
      </button>
    </div>
  )
}
