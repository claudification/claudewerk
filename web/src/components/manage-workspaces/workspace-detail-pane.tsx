/** The right column: Members (order within one workspace) or Matrix (every
 *  project against every workspace). Both write through the same toggle. */

import { useState } from 'react'
import type { Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'
import { useWorkspaceActions } from '../project-list/workspace-actions'
import type { WorkspaceInventory } from './use-workspace-inventory'
import { WorkspaceMatrixPane } from './workspace-matrix-pane'
import { WorkspaceMembersPane } from './workspace-members-pane'

type View = 'members' | 'matrix'

function ViewTab({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'h-6 px-2.5 rounded-md text-[10px] font-mono transition-colors',
        active ? 'bg-accent/20 text-foreground ring-1 ring-accent/30' : 'text-fg-dim hover:text-foreground',
      )}
    >
      {children}
    </button>
  )
}

function PaneBody({
  view,
  selected,
  inventory,
}: {
  view: View
  selected: Workspace | undefined
  inventory: WorkspaceInventory
}) {
  const actions = useWorkspaceActions()

  if (view === 'matrix') return <WorkspaceMatrixPane inventory={inventory} onToggle={actions.toggleProject} />
  if (!selected) {
    return <p className="text-[10px] text-fg-dim py-2">Create a workspace to start filing projects.</p>
  }
  return (
    <WorkspaceMembersPane
      wsId={selected.id}
      wsName={selected.name}
      inventory={inventory}
      onToggle={uri => actions.toggleProject(uri, selected.id)}
    />
  )
}

export function WorkspaceDetailPane({
  selected,
  inventory,
}: {
  selected: Workspace | undefined
  inventory: WorkspaceInventory
}) {
  const [view, setView] = useState<View>('members')

  return (
    <div className="flex-1 min-w-0 flex flex-col gap-2 border-l border-border pl-3">
      <div className="flex items-center gap-1 shrink-0">
        <ViewTab active={view === 'members'} onClick={() => setView('members')}>
          Members
        </ViewTab>
        <ViewTab active={view === 'matrix'} onClick={() => setView('matrix')}>
          Matrix
        </ViewTab>
      </div>
      <PaneBody view={view} selected={selected} inventory={inventory} />
    </div>
  )
}
