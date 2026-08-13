/**
 * MANAGE WORKSPACES -- one parkable, detachable, global-scoped surface for the
 * whole workspace axis: the list (reorder, rename, colour, custom key), and the
 * membership picture (Members = order within one workspace, Matrix = everything
 * against everything).
 *
 * NO DRAFT, NO SAVE. Every edit applies immediately, exactly like the tab-strip
 * context menus it replaces -- a draft layer would only create a second truth
 * that can disagree with the sidebar rendering behind the modal.
 */

import { closestCenter, DndContext } from '@dnd-kit/core'
import { Layers } from 'lucide-react'
import { useState } from 'react'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { ModalSurface } from '../modal-surface'
import { MANAGE_WORKSPACES_MODAL } from './manage-workspaces-state'
import { useWorkspaceDragEnd, useWorkspaceDragSensors } from './use-workspace-dnd'
import { useWorkspaceInventory } from './use-workspace-inventory'
import { WorkspaceDetailPane } from './workspace-detail-pane'
import { WorkspaceRailColumn } from './workspace-rail-column'

function ManageWorkspacesBody() {
  const inventory = useWorkspaceInventory()
  const [selectedId, setSelectedId] = useState<string | null>(null)

  // Falls back to the first workspace so the right pane is never blank while one
  // exists -- including right after the selected one is deleted.
  const selected = inventory.workspaces.find(w => w.id === selectedId) ?? inventory.workspaces[0]
  const sensors = useWorkspaceDragSensors()
  const onDragEnd = useWorkspaceDragEnd(inventory, selected?.id)

  return (
    <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
      <div className="flex-1 min-h-0 flex gap-3 p-3">
        <WorkspaceRailColumn inventory={inventory} selectedId={selected?.id} onSelect={setSelectedId} />
        <WorkspaceDetailPane selected={selected} inventory={inventory} />
      </div>
    </DndContext>
  )
}

export function ManageWorkspacesModal() {
  const modal = useManagedModal(MANAGE_WORKSPACES_MODAL)
  if (modal.presentation === 'closed') return null

  return (
    <ModalSurface
      modal={modal}
      title="Workspaces"
      icon={<Layers className="size-4 text-accent" />}
      className="max-w-5xl w-[92vw] top-[7vh] translate-y-0 h-[80vh]"
    >
      <ManageWorkspacesBody />
    </ModalSurface>
  )
}
