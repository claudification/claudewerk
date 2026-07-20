/**
 * Action FAB - Mobile floating action button with vertical fan expansion
 *
 * Position: fixed bottom-right. Tap to expand fan of action buttons.
 * Double-tap the main button to alt-tab to previous conversation.
 * Actions are context-aware: shows terminate for active conversations,
 * revive/dismiss for ended conversations.
 * Mobile only - hidden on desktop (hover-capable devices).
 */

import { type MouseEvent, useCallback, useEffect, useRef, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { cn, haptic } from '@/lib/utils'
import { quickSwitchConversation } from '@/lib/workspace-switch'
import { buildActions, type FanAction } from './action-fab-actions'
import { FanItem } from './action-fab-item'

export function ActionFab() {
  const [expanded, setExpanded] = useState(false)
  const [rawConfirmId, setConfirmId] = useState<string | null>(null)
  // confirmId is only meaningful when the fan is expanded; derive it inline
  // instead of syncing via useEffect (react-doctor/no-derived-state).
  const confirmId = expanded ? rawConfirmId : null
  const lastTapRef = useRef(0)
  const selectedConversationId = useConversationsStore(state => state.selectedConversationId)
  const conversation = useConversationsStore(state =>
    state.selectedConversationId ? state.conversationsById[state.selectedConversationId] : undefined,
  )

  const actions = buildActions(conversation, selectedConversationId)

  // Compute cumulative Y offsets with extra gap before dangerous actions
  const offsets = actions.reduce<number[]>((acc, action, i) => {
    const prevBottom = i === 0 ? 0 : acc[i - 1]
    const gap = action.dangerous ? 60 : 44 // extra spacing for dangerous
    acc.push(prevBottom + gap)
    return acc
  }, [])

  const singleTapTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const handleMainTap = useCallback(() => {
    const now = Date.now()
    if (now - lastTapRef.current < 300) {
      // Double-tap: cancel pending single-tap, alt-tab to previous conversation
      if (singleTapTimer.current) {
        clearTimeout(singleTapTimer.current)
        singleTapTimer.current = null
      }
      haptic('double')
      setExpanded(false)
      setConfirmId(null)
      quickSwitchConversation()
      lastTapRef.current = 0
      return
    }
    lastTapRef.current = now
    haptic('tap')
    // Delay toggle to allow double-tap detection
    singleTapTimer.current = setTimeout(() => {
      singleTapTimer.current = null
      setExpanded(prev => {
        if (prev) setConfirmId(null) // closing the fan clears pending confirmation
        return !prev
      })
    }, 300)
  }, [])

  const handleActivate = useCallback(
    (e: MouseEvent, action: FanAction) => {
      e.stopPropagation()
      if (action.dangerous && confirmId !== action.id) {
        // First tap on dangerous action: show confirmation
        haptic('tick')
        setConfirmId(action.id)
        return
      }
      haptic('tap')
      action.action()
      setExpanded(false)
      setConfirmId(null)
    },
    [confirmId],
  )

  // Close fan on outside tap
  useEffect(() => {
    if (!expanded) return
    function handleClick(e: globalThis.MouseEvent) {
      const target = e.target as HTMLElement
      if (!target.closest('[data-action-fab]')) {
        setExpanded(false)
        setConfirmId(null)
      }
    }
    document.addEventListener('click', handleClick, { capture: true })
    return () => document.removeEventListener('click', handleClick, { capture: true })
  }, [expanded])

  // confirmId derived inline from expanded -- no useEffect needed.

  return (
    <div data-action-fab className="fixed z-[56] right-3" style={{ width: 44, height: 44, top: 'calc(50% + 32px)' }}>
      {/* Action buttons - vertical stack going UP from the FAB */}
      {actions.map((action, i) => (
        <FanItem
          key={action.id}
          action={action}
          index={i}
          offset={offsets[i]}
          expanded={expanded}
          confirmId={confirmId}
          onActivate={handleActivate}
        />
      ))}

      {/* Main FAB button */}
      <button
        type="button"
        className={cn(
          'absolute bottom-0 right-0 w-11 h-11 rounded-full flex items-center justify-center',
          'shadow-lg border transition-all duration-150',
          'touch-none select-none',
          expanded
            ? 'bg-primary/20 border-primary/20 text-primary rotate-45'
            : 'bg-background/80 border-border/50 text-muted-foreground active:scale-95',
        )}
        onClick={handleMainTap}
      >
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2.5"
          role="img"
          aria-label="Actions"
        >
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
      </button>
    </div>
  )
}
