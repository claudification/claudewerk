/** Right pane, "Matrix" view: the whole membership picture at once -- every
 *  project against every workspace. This is the view that makes ZERO / ONE /
 *  MANY visible; a project row with no ticks lives only in All, a row with three
 *  ticks lives in three workspaces, and both are legal. */

import { Check } from 'lucide-react'
import { useState } from 'react'
import { projectPath, type Workspace } from '@/lib/types'
import { cn } from '@/lib/utils'
import { colorDot } from '../project-list/workspace-colors'
import type { WorkspaceInventory } from './use-workspace-inventory'

const CELL_BASE = 'size-5 rounded grid place-items-center border transition-colors'

function Cell({
  member,
  wsName,
  color,
  onToggle,
}: {
  member: boolean
  wsName: string
  color: string | undefined
  onToggle: () => void
}) {
  const style = member ? `border-transparent ${colorDot(color)}` : 'border-border hover:border-foreground/40'
  return (
    <td className="text-center px-0.5">
      <button
        type="button"
        onClick={onToggle}
        title={`${member ? 'Remove from' : 'Add to'} ${wsName}`}
        className={cn(CELL_BASE, style)}
      >
        {member && <Check className="size-3 text-background" />}
      </button>
    </td>
  )
}

export function WorkspaceMatrixPane({
  inventory,
  onToggle,
}: {
  inventory: WorkspaceInventory
  onToggle: (projectUri: string, wsId: string) => void
}) {
  const [filter, setFilter] = useState('')
  const rows = inventory.projects.filter(uri => inventory.labelOf(uri).toLowerCase().includes(filter.toLowerCase()))

  return (
    <div className="flex-1 min-h-0 flex flex-col gap-2">
      <input
        value={filter}
        onChange={e => setFilter(e.target.value)}
        placeholder="filter projects…"
        className="h-6 shrink-0 bg-background border border-border rounded px-2 text-[11px] font-mono outline-none focus:ring-1 focus:ring-primary"
      />

      <div className="flex-1 min-h-0 overflow-auto">
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-background z-10">
            <tr>
              <th className="text-left font-normal text-[10px] uppercase tracking-wider text-fg-dim py-1">
                Project
              </th>
              {inventory.workspaces.map((ws: Workspace) => (
                <th key={ws.id} className="px-0.5 pb-1 align-bottom" title={ws.name}>
                  <div className="flex flex-col items-center gap-1">
                    <span className={cn('size-1.5 rounded-full', colorDot(ws.color))} />
                    <span className="text-[9px] font-mono text-muted-foreground max-w-[3.5rem] truncate">
                      {ws.name}
                    </span>
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map(uri => {
              const memberOf = inventory.memberOf.get(uri) ?? new Set<string>()
              return (
                <tr key={uri} className="border-t border-border-subtle hover:bg-accent/5">
                  <td className="py-1 pr-2 max-w-0 w-full">
                    <div className="flex items-center gap-2">
                      <span className="truncate" title={projectPath(uri)}>
                        {inventory.labelOf(uri)}
                      </span>
                      {memberOf.size === 0 && (
                        <span className="text-[9px] text-fg-faint shrink-0">All only</span>
                      )}
                    </div>
                  </td>
                  {inventory.workspaces.map(ws => (
                    <Cell
                      key={ws.id}
                      member={memberOf.has(ws.id)}
                      wsName={ws.name}
                      color={ws.color}
                      onToggle={() => onToggle(uri, ws.id)}
                    />
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
