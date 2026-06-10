import { memo, type ReactNode, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { useConversationsStore } from '@/hooks/use-conversations'
import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import { projectPath } from '@/lib/types'
import { cn, haptic } from '@/lib/utils'
import { Markdown } from '../markdown'
import { Dialog, DialogContent, DialogTitle } from '../ui/dialog'
import { InlineConfirmButton } from './inline-confirm-button'
import { StatusIndicator } from './status-indicator'

// ─── Spawn lineage (Phase 4) ───────────────────────────────────────

/** Direct-children count for a conversation. Prefers the REST `directChildCount`;
 *  falls back to walking the local conversation list (WS conversation updates
 *  don't carry directChildCount, so a live control panel walks -- which is also
 *  the authoritative live source the info dialog's children list uses). */
function useDirectChildCount(conversation: Conversation): number {
  return useConversationsStore(s => {
    if (typeof conversation.directChildCount === 'number') return conversation.directChildCount
    let n = 0
    for (const c of selectConversations(s.conversationsById)) if (c.parentConversationId === conversation.id) n++
    return n
  })
}

/** Neutral meta-chip rendering of the "N spawned" badge. Shared by the meta
 *  footers (Full + Compact) and the SpawnRootStub. */
function spawnedBadge(count: number): ReactNode {
  return (
    <span
      className="px-1 py-0.5 text-[8px] rounded bg-muted text-muted-foreground font-medium"
      title={`Spawned ${count} conversation${count > 1 ? 's' : ''}`}
    >
      {count} spawned
    </span>
  )
}

/** "N spawned" badge -- shown on a conversation that has spawned children. */
function SpawnedChildrenBadge({ conversation }: { conversation: Conversation }) {
  const count = useDirectChildCount(conversation)
  if (count <= 0) return null
  return spawnedBadge(count)
}

/** Title-row attention badges shared by the full + compact cards: pending link,
 *  pending permission, waiting-for-input, notification, and "N spawned". Owns
 *  the pending-link / pending-permission store subscriptions so the two cards
 *  don't each duplicate the badge markup. */
export function ConversationAttentionBadges({ conversation }: { conversation: Conversation }) {
  const hasPendingPermission = useConversationsStore(s =>
    s.pendingPermissions.some(p => p.conversationId === conversation.id),
  )
  const hasPendingLink = useConversationsStore(s =>
    s.pendingProjectLinks.some(r => r.fromConversation === conversation.id || r.toConversation === conversation.id),
  )
  return (
    <>
      {hasPendingLink && <span className="text-[9px] text-teal-400 font-bold animate-pulse">LINK</span>}
      {hasPendingPermission && <span className="text-[9px] text-amber-400 font-bold animate-pulse">PERM</span>}
      {conversation.pendingAttention && (
        <span className="text-[9px] text-amber-400 font-bold animate-pulse">WAITING</span>
      )}
      {conversation.hasNotification && <span className="text-[9px] text-teal-400 font-bold">NOTIFY</span>}
      <SpawnedChildrenBadge conversation={conversation} />
    </>
  )
}

/** "from {parent}" subtext on a spawned child. Click navigates to the parent
 *  transcript. Degrades to "(deleted)" when the parent no longer exists. */
export function SpawnedFromSubtext({
  conversation,
  padClass = 'pl-1',
}: {
  conversation: Conversation
  padClass?: string
}) {
  const parentId = conversation.parentConversationId
  const selectConversation = useConversationsStore(s => s.selectConversation)
  const parentTitle = useConversationsStore(s => {
    if (!parentId) return null
    const p = s.conversationsById[parentId]
    return p ? p.title || p.agentName || p.id.slice(0, 8) : null
  })
  if (!parentId) return null
  const deleted = parentTitle === null
  return (
    <div className={cn('mt-0.5 text-[9px] text-muted-foreground/60 truncate', padClass)}>
      <button
        type="button"
        disabled={deleted}
        onClick={e => {
          e.stopPropagation()
          if (deleted) return
          haptic('tap')
          selectConversation(parentId, 'click')
        }}
        className={cn(
          'inline-flex items-center gap-0.5 max-w-full',
          deleted ? 'cursor-default' : 'cursor-pointer hover:text-foreground',
        )}
        title={deleted ? 'Parent conversation no longer exists' : `Spawned from ${parentTitle}`}
      >
        <span className="shrink-0">{'↪'}</span>
        <span className="truncate">from {deleted ? '(deleted)' : parentTitle}</span>
      </button>
    </div>
  )
}

/** Dimmed orphan-root row: a spawn root no longer in the live set (ended /
 *  inactive) pulled into its lineage group for context. No pulse, no selection
 *  ring, no action badges -- click still opens the transcript. */
export const SpawnRootStub = memo(function SpawnRootStub({ conversationId }: { conversationId: string }) {
  const conversation = useConversationsStore(s => s.conversationsById[conversationId])
  const selectConversation = useConversationsStore(s => s.selectConversation)
  if (!conversation) return null
  const title = conversation.title || conversation.agentName || conversation.id.slice(0, 8)
  return (
    <button
      type="button"
      data-conversation-id={conversation.id}
      onClick={() => {
        haptic('tap')
        selectConversation(conversation.id, 'click')
      }}
      className="w-full text-left border border-border/60 p-2 pl-4 transition-colors cursor-pointer hover:border-primary/40 appearance-none bg-transparent text-inherit"
      title={`Spawn root -- ${projectPath(conversation.project)}`}
    >
      <div className="flex items-center gap-1.5">
        <StatusIndicator status={conversation.status} adHoc={conversation.capabilities?.includes('ad-hoc')} />
        <span className="font-mono text-[11px] truncate flex-1 text-muted-foreground">{title}</span>
        <SpawnedChildrenBadge conversation={conversation} />
      </div>
    </button>
  )
})

// ─── Conversation lineage (kept here -- still used by InactiveProjectItem in the future) ────

// ─── Ad-hoc result text modal ─────────────────────────────────────

export function ResultTextModal({ conversation }: { conversation: Conversation }) {
  const [open, setOpen] = useState(false)

  if (!conversation.resultText) return null

  return (
    <>
      {/* nested inside conversation row interactive; semantic <button> would be invalid HTML */}
      {/* react-doctor-disable-next-line react-doctor/prefer-tag-over-role */}
      <span
        role="button"
        tabIndex={0}
        className="text-[10px] text-teal-400/60 hover:text-teal-400 cursor-pointer transition-colors shrink-0"
        title="View result"
        onClick={e => {
          e.stopPropagation()
          haptic('tap')
          setOpen(true)
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.stopPropagation()
            haptic('tap')
            setOpen(true)
          }
        }}
      >
        {'\u2398'}
      </span>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="font-mono">
          <DialogTitle className="pr-8 pb-2 border-b border-border">
            <div className="flex items-center gap-2">
              <span className="text-teal-400">{'\u26A1'}</span>
              <span>Ad-hoc Result</span>
              <span className="text-[10px] text-muted-foreground/50 font-normal">{conversation.id.slice(0, 12)}</span>
              <button
                type="button"
                className="ml-auto mr-6 text-[10px] text-muted-foreground hover:text-foreground transition-colors cursor-pointer px-2 py-1 border border-border hover:border-primary"
                onClick={() => {
                  navigator.clipboard.writeText(conversation.resultText || '')
                  haptic('success')
                }}
              >
                copy
              </button>
            </div>
          </DialogTitle>
          <div className="overflow-y-auto max-h-[70vh] p-4">
            <Markdown>{conversation.resultText}</Markdown>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}

export function DismissButton({ conversationId }: { conversationId: string }) {
  const dismissConversation = useConversationsStore(s => s.dismissConversation)

  return (
    <InlineConfirmButton
      onConfirm={() => dismissConversation(conversationId)}
      trigger={requestConfirm => (
        // nested inside conversation row interactive; semantic <button> would be invalid HTML
        // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
        <div
          role="button"
          tabIndex={0}
          onClick={requestConfirm}
          onKeyDown={e => {
            if (e.key === 'Enter' || e.key === ' ') requestConfirm(e)
          }}
          className="opacity-0 group-hover:opacity-100 [@media(hover:none)]:opacity-100 text-muted-foreground/40 hover:text-destructive transition-opacity cursor-pointer px-0.5"
          title="Dismiss conversation"
        >
          {'\u2715'}
        </div>
      )}
    />
  )
}

// ─── Inline rename input ─────────────────────────────────────────────

export function InlineRename({ conversation }: { conversation: Conversation }) {
  const renameConversation = useConversationsStore(s => s.renameConversation)
  const setRenamingConversationId = useConversationsStore(s => s.setRenamingConversationId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(conversation.title || '')

  useEffect(() => {
    // Delay to let Radix context menu fully close and release focus
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    renameConversation(conversation.id, value.trim())
    haptic('success')
  }

  return (
    <input
      ref={inputRef}
      aria-label="Rename conversation"
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setRenamingConversationId(null)
      }}
      onClick={e => e.stopPropagation()}
      onBlur={submit}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className="w-full bg-background/80 border border-accent text-[10px] font-mono px-1 py-0.5 outline-none text-foreground"
      placeholder="conversation name"
    />
  )
}

// ─── Inline description input ───────────────────────────────────────

export function InlineDescription({ conversation }: { conversation: Conversation }) {
  const updateDescription = useConversationsStore(s => s.updateDescription)
  const setEditingDescriptionConversationId = useConversationsStore(s => s.setEditingDescriptionConversationId)
  const inputRef = useRef<HTMLInputElement>(null)
  const [value, setValue] = useState(conversation.description || '')

  useEffect(() => {
    const t = setTimeout(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    }, 50)
    return () => clearTimeout(t)
  }, [])

  function submit() {
    updateDescription(conversation.id, value.trim())
    haptic('success')
  }

  return (
    <input
      ref={inputRef}
      aria-label="Edit conversation description"
      value={value}
      onChange={e => setValue(e.target.value)}
      onKeyDown={e => {
        e.stopPropagation()
        if (e.key === 'Enter') submit()
        if (e.key === 'Escape') setEditingDescriptionConversationId(null)
      }}
      onClick={e => e.stopPropagation()}
      onBlur={submit}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
      data-1p-ignore
      data-lpignore="true"
      data-form-type="other"
      className="w-full bg-background/80 border border-accent/50 text-[10px] font-mono px-1 py-0.5 outline-none text-muted-foreground italic"
      placeholder="conversation description"
    />
  )
}

// ─── Conversation card outer agent host (shared by Full + Compact) ────────

function BatchCheckbox({ conversationId }: { conversationId: string }) {
  const { isAdmin, batchActive, isSelected } = useConversationsStore(
    useShallow(s => ({
      isAdmin: s.permissions.canAdmin,
      batchActive: s.currentBatchId !== null || s.selectedForBatch.size > 0,
      isSelected: s.selectedForBatch.has(conversationId),
    })),
  )
  const toggle = useConversationsStore(s => s.toggleBatchSelection)
  if (!isAdmin || !batchActive) return null
  return (
    <input
      type="checkbox"
      aria-label="Select for batch operation"
      checked={isSelected}
      onClick={e => {
        e.stopPropagation()
      }}
      onChange={() => toggle(conversationId)}
      className="mr-2 shrink-0 cursor-pointer accent-accent"
    />
  )
}

export function ConversationItemShell({
  conversation,
  isSelected,
  displayColor,
  ghost = false,
  onClick,
  children,
}: {
  conversation: Conversation
  isSelected: boolean
  displayColor: string | undefined
  /** Discovered, not-yet-attached daemon worker -- rendered translucent + dashed. */
  ghost?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    // shell wraps nested interactives (dismiss/attach/etc); semantic <button> would nest buttons
    <div
      data-conversation-id={conversation.id}
      // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
      role="button"
      tabIndex={0}
      onClick={onClick}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onClick()
      }}
      className={cn(
        // content-visibility:auto skips render-tree + layout + paint + layer
        // construction for off-screen rows (the sidebar's dominant cost: ~1
        // SVG icon subtree per conversation x ~1000 rows). The element itself
        // stays in the DOM (data-conversation-id preserved) so scroll-into-view,
        // locate, pulse, context menu and DnD all keep working. contain-
        // intrinsic-size reserves a height for skipped rows (`auto` remembers
        // the real measured height after first paint) so the scrollbar is stable.
        'w-full text-left border transition-colors group cursor-pointer [content-visibility:auto]',
        'p-2 pl-4 text-[11px] [contain-intrinsic-size:auto_2.25rem]',
        isSelected && conversation.planMode
          ? 'border-blue-500 bg-blue-500/15 ring-1 ring-blue-500/50 shadow-[0_0_8px_rgba(59,130,246,0.2)]'
          : isSelected
            ? 'border-accent bg-accent/15 ring-1 ring-accent/50 shadow-[0_0_8px_rgba(122,162,247,0.15)]'
            : conversation.planMode
              ? 'border-blue-500/40 hover:border-blue-400/60'
              : displayColor
                ? 'border-border hover:border-primary'
                : 'border-border hover:border-primary hover:bg-card',
        // Ghost: discovered daemon worker not yet attached. Dashed violet,
        // faint tint, slightly dimmed -- reads as "phantom" vs an owned row.
        ghost && !isSelected && 'border-dashed border-violet-500/40 bg-violet-500/[0.04] opacity-90',
      )}
      style={
        isSelected && conversation.planMode
          ? {
              borderLeftColor: 'rgb(59 130 246)',
              borderLeftWidth: '3px',
            }
          : !isSelected && conversation.planMode
            ? {
                borderLeftColor: 'rgb(59 130 246)',
                borderLeftWidth: '3px',
                backgroundColor: 'color-mix(in oklch, rgb(59 130 246) 8%, transparent)',
              }
            : displayColor && !isSelected
              ? { borderLeftColor: displayColor, borderLeftWidth: '3px', backgroundColor: `${displayColor}15` }
              : undefined
      }
    >
      <div className="flex items-start">
        <BatchCheckbox conversationId={conversation.id} />
        <div className="flex-1 min-w-0">{children}</div>
      </div>
    </div>
  )
}

// ─── Running tasks / subagents / teammates block (shared) ─────────

export function ConversationItemTasksBlock({
  conversation,
  selectedSubagentId,
}: {
  conversation: Conversation
  selectedSubagentId: string | null
}) {
  const completedTasks = conversation.completedTasks ?? []
  const hasContent =
    conversation.activeTasks.length > 0 ||
    conversation.pendingTasks.length > 0 ||
    completedTasks.length > 0 ||
    conversation.subagents.length > 0 ||
    conversation.teammates.some(t => t.status === 'working')
  if (!hasContent) return null

  const overflow = conversation.activeTasks.length + conversation.pendingTasks.length - 5
  const completedMore = (conversation.completedTaskCount ?? completedTasks.length) - completedTasks.length
  const now = Date.now()

  return (
    <div className="mt-1 space-y-0.5">
      {conversation.activeTasks.slice(0, 5).map(task => (
        <div key={task.id} className="text-[11px] text-active/80 font-mono truncate pl-1">
          <span className="text-active mr-1">{'\u25B8'}</span>
          {task.subject}
        </div>
      ))}
      {conversation.pendingTasks.slice(0, Math.max(0, 5 - conversation.activeTasks.length)).map(task => (
        <div key={task.id} className="text-[11px] text-amber-400/50 font-mono truncate pl-1">
          <span className="text-amber-400/40 mr-1">{'\u25CB'}</span>
          {task.subject}
        </div>
      ))}
      {overflow > 0 && <div className="text-[10px] text-muted-foreground pl-1 font-mono">..{overflow} more</div>}
      {completedTasks.map(task => (
        <div key={task.id} className="text-[11px] text-muted-foreground/50 font-mono truncate pl-1">
          <span className="text-active/40 mr-1">{'✓'}</span>
          <span className="line-through">{task.subject}</span>
        </div>
      ))}
      {completedMore > 0 && (
        <div className="text-[10px] text-muted-foreground pl-1 font-mono">..{completedMore} more</div>
      )}
      {(() => {
        const runningNodes: ReactNode[] = []
        const stoppedNodes: ReactNode[] = []
        for (const a of conversation.subagents) {
          if (a.status === 'running') {
            runningNodes.push(
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/80 font-mono truncate pl-1',
                  selectedSubagentId === a.agentId && 'text-pink-300 font-bold',
                )}
              >
                <span className="text-pink-400 mr-1">{'\u25CF'}</span>
                {a.description || a.agentType} <span className="text-pink-400/50">{a.agentId.slice(0, 6)}</span>
              </div>,
            )
          } else if (a.status === 'stopped' && a.stoppedAt && now - a.stoppedAt < 30 * 60 * 1000) {
            stoppedNodes.push(
              <div
                key={a.agentId}
                className={cn(
                  'text-[11px] text-pink-400/40 font-mono truncate pl-1',
                  selectedSubagentId === a.agentId && 'text-pink-400/80 font-bold',
                )}
              >
                <span className="mr-1">{'\u25CB'}</span>
                {a.description || a.agentType} <span className="text-pink-400/30">{a.agentId.slice(0, 6)}</span>
              </div>,
            )
          }
        }
        return (
          <>
            {runningNodes}
            {stoppedNodes}
          </>
        )
      })()}
      {(() => {
        const out: ReactNode[] = []
        for (const t of conversation.teammates) {
          if (t.status !== 'working') continue
          out.push(
            <div key={t.name} className="text-[11px] text-purple-400/80 font-mono truncate pl-1">
              <span className="text-purple-400 mr-1">{'\u2691'}</span>
              {t.name}
              {t.currentTaskSubject ? `: ${t.currentTaskSubject}` : ''}
            </div>,
          )
        }
        return out
      })()}
    </div>
  )
}
