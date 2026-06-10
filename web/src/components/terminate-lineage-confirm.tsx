/**
 * TerminateLineageConfirmDialog - Confirmation before terminating a whole
 * spawn lineage (a conversation + all its descendants). Renders the subtree as
 * an indented tree so the user sees exactly what will die; already-ended
 * members are shown struck-through and skipped. Only active members are killed.
 *
 * Imperative API: openTerminateLineageConfirm(conversationId) from anywhere.
 * Keyboard: Enter/Y = confirm (when something is active), Escape/N = cancel.
 */

import { useEffect, useMemo, useState } from 'react'
import { useConversations, useConversationsStore } from '@/hooks/use-conversations'
import { useKeyLayer } from '@/lib/key-layers'
import { cn, haptic } from '@/lib/utils'
import { collectLineageSubtree, type LineageSubtreeMember } from './project-list/lineage'
import { StatusIndicator } from './project-list/status-indicator'
import { _terminateLineageConfirmBus } from './terminate-lineage-confirm-trigger'
import { Dialog, DialogContent, DialogTitle } from './ui/dialog'
import { Kbd, KbdGroup } from './ui/kbd'

function memberTitle(m: LineageSubtreeMember): string {
  const c = m.conversation
  return c.title || c.agentName || c.id.slice(0, 8)
}

function TreeRow({ member }: { member: LineageSubtreeMember }) {
  return (
    <div
      className="flex items-center gap-1.5 py-0.5 text-[11px] font-mono"
      style={{ paddingLeft: `${member.depth * 14}px` }}
    >
      {member.depth > 0 && <span className="text-muted-foreground/40 shrink-0">{'↪'}</span>}
      <StatusIndicator status={member.conversation.status} />
      <span className={cn('truncate', member.isActive ? 'text-foreground' : 'text-muted-foreground/50 line-through')}>
        {memberTitle(member)}
      </span>
      {member.depth === 0 && <span className="text-[9px] text-muted-foreground/60 shrink-0">root</span>}
    </div>
  )
}

/** Right-aligned "N active · M ended" header badge. */
function CountBadge({ activeCount, endedCount }: { activeCount: number; endedCount: number }) {
  if (activeCount === 0) return <span className="text-muted-foreground/60">nothing active</span>
  return (
    <>
      <span className="text-destructive font-bold">{activeCount}</span> active
      {endedCount > 0 && <span className="text-muted-foreground/50"> · {endedCount} ended</span>}
    </>
  )
}

/** Body intro line describing what the confirm will do. */
function IntroLine({ activeCount, endedCount }: { activeCount: number; endedCount: number }) {
  if (activeCount === 0) return <>Everything in this lineage has already ended. Nothing to terminate.</>
  return (
    <>
      These <span className="text-yellow-400 font-bold">{activeCount}</span> conversation
      {activeCount > 1 ? 's' : ''} will be terminated. Any running process will be killed.
      {endedCount > 0 && ' Already-ended ones are skipped.'}
    </>
  )
}

export function TerminateLineageConfirmDialog() {
  const [conversationId, setConversationId] = useState<string | null>(null)
  const conversations = useConversations()
  const terminateLineage = useConversationsStore(s => s.terminateLineage)

  useEffect(() => {
    _terminateLineageConfirmBus.open = id => {
      haptic('tap')
      setConversationId(id)
    }
    return () => {
      _terminateLineageConfirmBus.open = null
    }
  }, [])

  const members = useMemo(
    () => (conversationId ? collectLineageSubtree(conversations, conversationId) : []),
    [conversations, conversationId],
  )
  const activeCount = members.filter(m => m.isActive).length
  const endedCount = members.length - activeCount
  const open = conversationId !== null

  function confirm() {
    if (conversationId && activeCount > 0) {
      terminateLineage(conversationId, 'dashboard-lineage')
      haptic('error')
    }
    setConversationId(null)
  }

  function cancel() {
    haptic('tap')
    setConversationId(null)
  }

  useKeyLayer(
    {
      Enter: confirm,
      y: confirm,
      n: cancel,
    },
    { id: 'terminate-lineage-confirm', enabled: open },
  )

  return (
    <Dialog open={open} onOpenChange={o => !o && cancel()}>
      <DialogContent className="font-mono max-w-md p-0 overflow-hidden">
        <DialogTitle className="sr-only">Terminate full lineage</DialogTitle>

        {/* Header */}
        <div className="px-4 py-3 border-b border-border flex items-center gap-2">
          <span className="text-destructive font-bold text-sm">TERMINATE</span>
          <span className="text-muted-foreground text-xs">full lineage</span>
          <span className="ml-auto text-[11px] text-muted-foreground">
            <CountBadge activeCount={activeCount} endedCount={endedCount} />
          </span>
        </div>

        {/* Tree */}
        <div className="px-4 py-3 max-h-[50vh] overflow-y-auto">
          <div className="text-[11px] text-muted-foreground mb-2">
            <IntroLine activeCount={activeCount} endedCount={endedCount} />
          </div>
          {members.map(m => (
            <TreeRow key={m.conversation.id} member={m} />
          ))}
        </div>

        {/* Actions */}
        <div className="px-4 pb-4 pt-1 flex items-center gap-3">
          <button
            type="button"
            onClick={confirm}
            disabled={activeCount === 0}
            className={cn(
              'flex-1 py-1.5 text-xs font-bold border transition-colors flex items-center justify-center gap-2',
              activeCount === 0
                ? 'border-border text-muted-foreground/40 cursor-not-allowed'
                : 'bg-destructive/20 border-destructive/40 text-destructive hover:bg-destructive/30',
            )}
          >
            Terminate lineage
            <KbdGroup>
              <Kbd>Y</Kbd>
            </KbdGroup>
          </button>
          <button
            type="button"
            onClick={cancel}
            className="flex-1 py-1.5 text-xs text-muted-foreground border border-border hover:bg-muted/50 transition-colors flex items-center justify-center gap-2"
          >
            Cancel
            <KbdGroup>
              <Kbd>N</Kbd>
            </KbdGroup>
          </button>
        </div>
      </DialogContent>
    </Dialog>
  )
}
