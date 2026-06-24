/**
 * ModalDock -- the global tray of every parked thing.
 *
 * Mirror of ShellDock. Two sources, one tray: manager-backed UI modals (see
 * use-modal-manager) AND minimized live dialogs (THE DIALOGUE, surfaced via
 * useMinimizedLiveDialogs). Each tile is owner-badged; clicking restores it,
 * warping back to its owner context first. Self-hides when nothing is parked.
 */
import { useMemo } from 'react'
import { LiveDialogDockTile } from '@/components/dialog/live-dialog-dock-tile'
import type { ModalRecord, ModalScope } from '@/hooks/modal-manager-types'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useMinimizedLiveDialogs } from '@/hooks/use-minimized-live-dialogs'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'
import { DockTile } from './dock-tile'

/** Project URI -> short basename badge. */
function projectLabel(uri: string): string {
  const tail = uri.replace(/\/+$/, '').split('/').pop()
  return tail ? `proj:${tail}` : 'project'
}

/** Short, human owner badge. `convTitle` is the pre-resolved conversation title. */
function ownerLabel(scope: ModalScope, convTitle: string | undefined): string {
  if (scope.type === 'project') return projectLabel(scope.uri)
  if (scope.type === 'conversation') return convTitle || scope.id.slice(0, 8)
  return 'global'
}

function ModalDockTile({ record }: { record: ModalRecord }) {
  const scope = record.scope
  const convId = scope.type === 'conversation' ? scope.id : undefined
  const convTitle = useConversationsStore(s => (convId ? s.conversationsById[convId]?.title : undefined))
  const restore = useModalManagerStore(s => s.restore)
  const close = useModalManagerStore(s => s.close)

  return (
    <DockTile
      title={record.title}
      owner={ownerLabel(scope, convTitle)}
      onRestore={() => restore(record.id)}
      onClose={() => close(record.id)}
    />
  )
}

export function ModalDock() {
  const records = useModalManagerStore(s => s.records)
  const currentConversationId = useConversationsStore(s => s.selectedConversationId)
  const liveDialogs = useMinimizedLiveDialogs(currentConversationId)

  const minimized = useMemo(
    () =>
      Object.values(records)
        .filter(r => r.phase === 'minimized')
        .sort((a, b) => a.openedAt - b.openedAt),
    [records],
  )

  if (minimized.length === 0 && liveDialogs.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1.5 overflow-x-auto py-1')} data-modal-dock>
      <span className="text-[9px] font-mono uppercase tracking-wide text-white/30 shrink-0 px-1">parked</span>
      {minimized.map(r => (
        <ModalDockTile key={r.id} record={r} />
      ))}
      {liveDialogs.map(d => (
        <LiveDialogDockTile key={d.conversationId} conversationId={d.conversationId} title={d.title} />
      ))}
    </div>
  )
}
