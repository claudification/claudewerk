/**
 * One board card: drag, click-to-edit, the actions menu.
 *
 * Extracted from `project-board.tsx` when that file crossed the split bar.
 * The division is INTERACTION here / PRESENTATION in `card-body.tsx`, which is
 * the same seam `CardBody` was originally cut along.
 */

import { useDraggable } from '@dnd-kit/core'
import type { EpicRollup } from '@shared/epic-cards'
import { epicHue } from '@shared/epic-color'
import { MoreHorizontal } from 'lucide-react'
import { useState } from 'react'
import { type BoardViewConfig, DENSITY_PADDING } from '@/hooks/use-board-view-config'
import type { ProjectTaskMeta, TaskStatus } from '@/hooks/use-project'
import { epicColorVars } from '@/lib/cards/epic-color-vars'
import { cn, haptic } from '@/lib/utils'
import { CardActions } from './card-actions'
import { CardBody } from './card-body'
import { cardEpicRole, epicHueSource } from './card-epic-role'

export function ProjectCard({
  task,
  view,
  epicIndex,
  onMove,
  onDelete,
  onArchive,
  onEdit,
  onOpenSlug,
}: {
  task: ProjectTaskMeta
  view: BoardViewConfig
  /** The whole index: a card needs its PARENT's rollup when it is a child and
   *  its OWN when it is an epic, and only the index can answer both. */
  epicIndex: Map<string, EpicRollup>
  onMove: (id: string, to: TaskStatus) => void
  onDelete: (id: string) => void
  onArchive: (id: string) => void
  onEdit: (task: ProjectTaskMeta) => void
  onOpenSlug: (slug: string) => void
}) {
  const [showActions, setShowActions] = useState(false)
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({
    id: `${task.status}/${task.slug}`,
    data: { slug: task.slug, status: task.status },
  })

  // A card wears its epic's colour as a left rail, so the board says which epic
  // a card belongs to without opening anything. Unparented cards get no rail at
  // all -- absence is the signal, a grey rail would just be noise. An EPIC
  // wears its own colour, which is what puts it at the head of the group it
  // owns instead of leaving it looking like an unrelated card.
  const role = cardEpicRole(task, epicIndex)
  const hueSource = epicHueSource(role, task)
  const style = {
    ...(transform ? { transform: `translate(${transform.x}px, ${transform.y}px)` } : {}),
    ...(hueSource ? epicColorVars(epicHue(hueSource, epicIndex.get(hueSource)?.card?.color)) : {}),
  }

  return (
    // task card carries dnd-kit drag handlers + nested action buttons; semantic <button> would nest buttons
    // react-doctor-disable-next-line react-doctor/prefer-tag-over-role
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        'group bg-surface-inset border border-border/70 hover:border-primary/45 transition-colors cursor-pointer',
        role.kind === 'child' && 'border-l-2 border-l-[color:var(--epic-solid)]',
        // Thicker rail on the epic itself: same hue as its children, but it is
        // the head of the group, not another member of it.
        role.kind === 'epic' && 'border-l-4 border-l-[color:var(--epic-solid)]',
        DENSITY_PADDING[view.density],
        isDragging && 'opacity-50 z-50',
      )}
      onClick={() => !isDragging && onEdit(task)}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onEdit(task)
      }}
      {...attributes}
      {...listeners}
      role="button"
      tabIndex={0}
    >
      <div className="flex items-start gap-2">
        <CardBody task={task} view={view} role={role} onOpenSlug={onOpenSlug} />
        <button
          type="button"
          className="shrink-0 p-0.5 text-muted-foreground/60 hover:text-foreground transition-colors"
          onClick={e => {
            e.stopPropagation()
            haptic('tap')
            setShowActions(!showActions)
          }}
        >
          <MoreHorizontal className="size-3.5" />
        </button>
      </div>

      {showActions && (
        <CardActions
          task={task}
          onMove={onMove}
          onArchive={onArchive}
          onDelete={onDelete}
          onDone={() => setShowActions(false)}
        />
      )}
    </div>
  )
}
