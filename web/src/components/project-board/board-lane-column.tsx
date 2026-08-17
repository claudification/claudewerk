/**
 * One kanban column, with its cards folded into groups.
 *
 * The column owns the lane ("where is this"); the group bars inside it own the
 * arrangement ("what is this part of"). Keeping both in one column is the whole
 * point of grouping over a second view -- an epic and a lane were never
 * competing facts, and the old mode toggle made you pick one.
 */

import { useDroppable } from '@dnd-kit/core'
import type { EpicRollup } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import type { TaskStatus } from '@/hooks/use-project'
import { cn } from '@/lib/utils'
import { BoardGroupBar } from './board-group-bar'
import type { CardGroup } from './board-grouping'
import { UNGROUPED_KEY } from './board-grouping'

function DroppableColumn({
  status,
  width,
  children,
}: {
  status: TaskStatus
  width: number
  children: React.ReactNode
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status })
  return (
    <div
      ref={setNodeRef}
      style={{ width: `${width}px`, minWidth: `${width}px` }}
      className={cn(
        'flex-1 flex flex-col border-r border-border last:border-r-0 transition-colors',
        isOver && 'bg-accent/5',
      )}
    >
      {children}
    </div>
  )
}

export function BoardLaneColumn({
  status,
  label,
  labelClass,
  width,
  groups,
  epicIndex,
  renderCard,
  footer,
}: {
  status: TaskStatus
  label: string
  labelClass: string
  width: number
  groups: CardGroup[]
  epicIndex: Map<string, EpicRollup>
  renderCard: (task: ProjectTaskMeta) => React.ReactNode
  footer?: React.ReactNode
}) {
  const count = groups.reduce((n, g) => n + g.cards.length, 0)
  // One unnamed group means "not grouped" -- drawing a bar over the whole
  // column would be furniture that says nothing.
  const showBars = groups.length > 1 || (groups.length === 1 && groups[0].key !== UNGROUPED_KEY)

  return (
    <DroppableColumn status={status} width={width}>
      <div className="px-3 py-2 border-b border-border/50 flex items-baseline gap-2 shrink-0">
        <span className={cn('text-chrome font-mono uppercase', labelClass)}>{label}</span>
        <span className="ml-auto text-tally font-mono tabular-nums text-foreground">{count}</span>
      </div>

      <div className="flex-1 overflow-y-auto pb-4">
        {groups.map(group => (
          <div key={group.key || '__ungrouped__'}>
            {showBars && <BoardGroupBar group={group} rollup={group.epicId ? epicIndex.get(group.epicId) : undefined} />}
            {group.cards.map(renderCard)}
          </div>
        ))}
        {footer}
      </div>
    </DroppableColumn>
  )
}
