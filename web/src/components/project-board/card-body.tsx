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
import { taskAge } from './board-constants'

/**
 * THE COLOUR LAW, on the card.
 *
 * Tags used to wear one of six hashed colours and priority a filled bordered
 * pill, so a card with three tags carried five coloured objects competing with
 * its own title -- the lowest-contrast thing on it. Tags are a FILTER handle,
 * not information: they go grey here and light up in the filter row when you
 * actually select one. Priority becomes two letters, and only `high` is
 * allowed a colour, because "this one is urgent" is the only priority fact
 * worth interrupting a scan for.
 *
 * The card's STRUCTURE is untouched -- same rows, same order, same rail.
 */
const CARD_PRIORITY: Record<string, string> = {
  high: 'text-destructive font-bold',
  medium: 'text-fg-dim',
  low: 'text-fg-dim',
}

const PRIORITY_MARK: Record<string, string> = { high: 'HI', medium: 'md', low: 'lo' }

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
        {task.created && <span className="text-[9px] text-fg-dim shrink-0">{taskAge(task.created)}</span>}
      </div>
      {task.bodyPreview && view.bodyLines > 0 && (
        <div className={cn('text-[10px] text-muted-foreground mt-0.5', CLAMP_CLASS[view.bodyLines])}>
          {task.bodyPreview}
        </div>
      )}
      {role.kind === 'epic' && <EpicCardProgress rollup={role.rollup} />}
      <div className="flex items-center gap-1.5 mt-1 flex-wrap">
        <EpicMarker role={role} onOpenSlug={onOpenSlug} />
        {task.priority && (
          <span className={cn('text-chrome font-mono', CARD_PRIORITY[task.priority] ?? CARD_PRIORITY.medium)}>
            {PRIORITY_MARK[task.priority] ?? task.priority}
          </span>
        )}
        {task.tags.map(tag => (
          <span
            key={tag}
            className="text-chrome px-1 py-0.5 border border-muted-foreground/28 text-fg-muted font-mono"
          >
            {tag}
          </span>
        ))}
      </div>
    </div>
  )
}
