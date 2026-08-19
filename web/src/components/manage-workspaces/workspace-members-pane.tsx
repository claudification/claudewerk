/** Right pane, "Members" view: what is IN the selected workspace, in the order
 *  the sidebar will render it (drag to rearrange), plus everything that is not,
 *  one click away from being added. */

import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable'
import { Folder, Plus, X } from 'lucide-react'
import { useState } from 'react'
import { type ProjectOrderNode, projectPath } from '@/lib/types'
import { SortableRow } from '../ui/sortable-row'
import type { WorkspaceInventory } from './use-workspace-inventory'

function MemberRow({ node, label, onRemove }: { node: ProjectOrderNode; label: string; onRemove: () => void }) {
  const isGroup = node.type === 'group'
  return (
    <SortableRow
      id={node.id}
      className="flex items-center gap-2 py-1 px-2 rounded border border-border bg-background text-xs"
    >
      {isGroup && <Folder className="size-3 text-primary/60 shrink-0" />}
      <span className="flex-1 truncate" title={isGroup ? node.name : projectPath(node.id)}>
        {isGroup ? node.name : label}
      </span>
      <button
        type="button"
        onClick={onRemove}
        className="text-fg-faint hover:text-destructive shrink-0"
        title="Remove from this workspace (the project itself is untouched)"
      >
        <X className="size-3.5" />
      </button>
    </SortableRow>
  )
}

export function WorkspaceMembersPane({
  wsId,
  wsName,
  inventory,
  onToggle,
}: {
  wsId: string
  wsName: string
  inventory: WorkspaceInventory
  onToggle: (projectUri: string) => void
}) {
  const [filter, setFilter] = useState('')
  const members = inventory.membersOf(wsId)
  const memberIds = new Set(members.map(n => n.id))
  const candidates = inventory.projects.filter(
    uri => !memberIds.has(uri) && inventory.labelOf(uri).toLowerCase().includes(filter.toLowerCase()),
  )

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <p className="text-[10px] text-fg-dim shrink-0">
        Drag to set the order <span className="text-foreground/60">{wsName}</span> renders in. A project can sit in as
        many workspaces as you like -- removing it here never removes it anywhere else.
      </p>

      <div className="space-y-1 shrink-0">
        <SortableContext items={members.map(n => n.id)} strategy={verticalListSortingStrategy}>
          {members.length === 0 ? (
            <p className="text-[10px] text-fg-dim px-1 py-2 border border-dashed border-border rounded text-center">
              Empty -- this workspace shows nothing in the sidebar yet.
            </p>
          ) : (
            members.map(node => (
              <MemberRow
                key={node.id}
                node={node}
                label={inventory.labelOf(node.id)}
                onRemove={() => onToggle(node.id)}
              />
            ))
          )}
        </SortableContext>
      </div>

      <div className="flex items-center gap-2 pt-1 shrink-0">
        <span className="text-[10px] uppercase tracking-wider text-fg-dim">Add</span>
        <input
          value={filter}
          onChange={e => setFilter(e.target.value)}
          placeholder="filter projects…"
          className="flex-1 h-6 bg-background border border-border rounded px-2 text-[11px] font-mono outline-none focus:ring-1 focus:ring-primary"
        />
      </div>

      <div className="flex-1 min-h-0 overflow-y-auto space-y-1">
        {candidates.map(uri => (
          <button
            key={uri}
            type="button"
            onClick={() => onToggle(uri)}
            title={projectPath(uri)}
            className="w-full flex items-center gap-2 py-1 px-2 rounded border border-transparent hover:border-border hover:bg-accent/10 text-xs text-muted-foreground hover:text-foreground"
          >
            <Plus className="size-3 shrink-0" />
            <span className="flex-1 truncate text-left">{inventory.labelOf(uri)}</span>
            <span className="text-[10px] tabular-nums text-fg-faint">
              {inventory.memberOf.get(uri)?.size ?? 0} ws
            </span>
          </button>
        ))}
      </div>
    </div>
  )
}
