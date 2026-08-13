/** The left column: the sortable workspace rail plus its "new workspace" row. */

import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { useWorkspaceActions } from '../project-list/workspace-actions'
import type { WorkspaceInventory } from './use-workspace-inventory'
import { AddWorkspaceRow, WorkspaceRow } from './workspace-rail'

function EmptyRail() {
  return (
    <p className="text-[10px] text-muted-foreground/50 px-1 py-2">
      No workspaces yet. A workspace is a filtered view of the sidebar -- projects stay in All regardless.
    </p>
  )
}

export function WorkspaceRailColumn({
  inventory,
  selectedId,
  onSelect,
}: {
  inventory: WorkspaceInventory
  selectedId: string | undefined
  onSelect: (wsId: string) => void
}) {
  const actions = useWorkspaceActions()
  const { workspaces } = inventory

  return (
    <div className="w-[19rem] shrink-0 flex flex-col gap-1.5 overflow-y-auto pr-1">
      <SortableContext items={workspaces.map(w => w.id)} strategy={verticalListSortingStrategy}>
        {workspaces.length === 0 && <EmptyRail />}
        {workspaces.map((ws, i) => (
          <WorkspaceRow
            key={ws.id}
            ws={ws}
            index={i}
            selected={selectedId === ws.id}
            memberCount={inventory.membersOf(ws.id).length}
            otherKeys={workspaces.flatMap(w => (w.id !== ws.id && w.key ? [w.key] : []))}
            actions={{
              onSelect: () => onSelect(ws.id),
              onRename: name => actions.rename(ws.id, name),
              onRecolor: color => actions.recolor(ws.id, color),
              onSetKey: key => actions.setKey(ws.id, key),
              onDelete: () => actions.remove(ws.id, null),
            }}
          />
        ))}
      </SortableContext>
      <AddWorkspaceRow onAdd={name => actions.create(name, workspaces.length)} />
    </div>
  )
}
