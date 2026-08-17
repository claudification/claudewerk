/**
 * Everything INSIDE a board card: title, age, body preview, epic rollup, chips.
 *
 * Split out of `ProjectCard` when adding the epic marker pushed that component
 * past the complexity gate. The division is deliberate and not just line count:
 * `ProjectCard` owns INTERACTION (drag, click-to-edit, the actions menu) and
 * this owns PRESENTATION. Nothing here has state or a handler except the one
 * navigation callback the child badge needs.
 */

import type { ProjectTaskMeta } from '@shared/project-task-types'
import { type BoardViewConfig, CLAMP_CLASS, TITLE_SIZE_CLASS } from '@/hooks/use-board-view-config'
import { cn } from '@/lib/utils'
import { PRIORITY_COLORS, tagColor, taskAge } from './board-constants'
import type { CardEpicRole } from './card-epic-role'
import { EpicBadge } from './epic-badge'
import { EpicCardProgress, EpicSelfChip } from './epic-card-marker'

/** The epic marker, whichever of the two a card is entitled to. Nothing for an
 *  unparented card -- an "unparented" chip on most of the board is pure noise. */
function EpicMarker({ role, onOpenSlug }: { role: CardEpicRole; onOpenSlug: (slug: string) => void }) {
  if (role.kind === 'epic') return <EpicSelfChip rollup={role.rollup} />
  if (role.kind === 'child') return <EpicBadge epicId={role.epicId} rollup={role.rollup} onOpen={onOpenSlug} />
  return null
}

export function CardBody({
  task,
  view,
  role,
  onOpenSlug,
}: {
  task: ProjectTaskMeta
  view: BoardViewConfig
  role: CardEpicRole
  onOpenSlug: (slug: string) => void
}) {
  return (
    <div className="flex-1 min-w-0">
      <div
        className={cn('font-mono text-foreground truncate flex items-center gap-1.5', TITLE_SIZE_CLASS[view.titleSize])}
      >
        <span className="truncate">{task.title}</span>
        {task.created && <span className="text-[9px] text-muted-foreground/65 shrink-0">{taskAge(task.created)}</span>}
      </div>
      {task.bodyPreview && view.bodyLines > 0 && (
        <div className={cn('text-[10px] text-muted-foreground mt-0.5', CLAMP_CLASS[view.bodyLines])}>
          {task.bodyPreview}
        </div>
      )}
      {role.kind === 'epic' && <EpicCardProgress rollup={role.rollup} />}
      <div className="flex items-center gap-1 mt-1 flex-wrap">
        <EpicMarker role={role} onOpenSlug={onOpenSlug} />
        {task.priority && (
          <span className={cn('text-[9px] px-1 py-0.5 border font-mono', PRIORITY_COLORS[task.priority])}>
            {task.priority}
          </span>
        )}
        {task.tags.map(tag => (
          <span key={tag} className={cn('text-[9px] px-1 py-0.5 border font-mono', tagColor(tag))}>
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}
