/**
 * ModalDockTile -- one parked manager-backed modal in the unified <Dock>.
 *
 * Owner-badged; clicking restores it, warping back to its owner context first
 * (see use-modal-manager / plan-unified-modals.md). Split out of the dock so the
 * tray stays small and this stays the single home for manager-tile rendering.
 */
import type { ModalRecord, ModalScope } from '@/hooks/modal-manager-types'
import { useConversationsStore } from '@/hooks/use-conversations'
import { useModalManagerStore } from '@/hooks/use-modal-manager'
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

export function ModalDockTile({ record }: { record: ModalRecord }) {
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
      {...(record.activity && { activity: record.activity })}
    />
  )
}
