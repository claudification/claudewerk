/**
 * ModalDock -- the global tray of minimized modals.
 *
 * Mirror of ShellDock for UI modals: every parked modal lands here regardless of
 * the current conversation/project, badged with its OWNER. Clicking a tile
 * restores it -- warping back to its owner context first (see use-modal-manager).
 * Self-hides when nothing is parked.
 */
import { Minus, X } from 'lucide-react'
import { useMemo } from 'react'
import type { ModalRecord, ModalScope } from '@/hooks/modal-manager-types'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
import { cn } from '@/lib/utils'

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
  const owner = ownerLabel(scope, convTitle)
  const restore = useModalManagerStore(s => s.restore)
  const close = useModalManagerStore(s => s.close)

  return (
    <div className="group flex items-center gap-1.5 rounded border border-white/10 bg-white/5 px-2 py-1 text-[11px] font-mono text-white/70 transition-colors hover:bg-white/10 hover:text-white">
      <Minus className="size-3 shrink-0 opacity-60" />
      <button
        type="button"
        onClick={() => restore(record.id)}
        className="flex items-center gap-1.5 max-w-[200px]"
        title={`Restore — ${owner}`}
      >
        <span className="truncate">{record.title}</span>
        <span className="shrink-0 rounded bg-white/10 px-1 text-[9px] uppercase tracking-wide text-white/50">
          {owner}
        </span>
      </button>
      <button
        type="button"
        onClick={() => close(record.id)}
        className="shrink-0 text-white/30 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
        title="Close"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

export function ModalDock() {
  const records = useModalManagerStore(s => s.records)
  const minimized = useMemo(
    () =>
      Object.values(records)
        .filter(r => r.phase === 'minimized')
        .sort((a, b) => a.openedAt - b.openedAt),
    [records],
  )

  if (minimized.length === 0) return null

  return (
    <div className={cn('flex items-center gap-1.5 overflow-x-auto py-1')} data-modal-dock>
      <span className="text-[9px] font-mono uppercase tracking-wide text-white/30 shrink-0 px-1">parked</span>
      {minimized.map(r => (
        <ModalDockTile key={r.id} record={r} />
      ))}
    </div>
  )
}
