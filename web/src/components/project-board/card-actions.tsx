/**
 * The per-card action toolbar, lifted out of `ProjectCard`.
 *
 * It was four conditional buttons inline in a component that had already grown
 * to 171 lines and 15 branches; every one of those branches was this row. The
 * card now decides WHETHER to show actions, and this decides what they are.
 */

import { Archive, ArrowLeft, ArrowRight, Trash2 } from 'lucide-react'
import type { ProjectTaskMeta, TaskStatus } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { NEXT_STATUS, PREV_STATUS } from './board-constants'

const ICON = 'size-3.5'
const BTN = 'p-1 text-muted-foreground hover:text-foreground transition-colors'

export function CardActions({
  task,
  onMove,
  onArchive,
  onDelete,
  onDone,
}: {
  task: ProjectTaskMeta
  onMove: (id: string, to: TaskStatus) => void
  onArchive: (id: string) => void
  onDelete: (id: string) => void
  /** Called after any action, so the card can close the toolbar. */
  onDone: () => void
}) {
  const prev = PREV_STATUS[task.status]
  const next = NEXT_STATUS[task.status]

  function run(action: () => void, feel: 'tap' | 'error' = 'tap') {
    haptic(feel)
    action()
    onDone()
  }

  return (
    <div
      role="toolbar"
      // biome-ignore lint/a11y/noNoninteractiveTabindex: roving-tabindex toolbar, focus is intentional
      tabIndex={0}
      className="flex items-center gap-0.5 mt-2 pt-2 border-t border-border/60"
      onClick={e => e.stopPropagation()}
      onKeyDown={e => e.stopPropagation()}
    >
      {prev && (
        <button
          type="button"
          title={`Move to ${prev}`}
          className={BTN}
          onClick={() => run(() => onMove(task.slug, prev))}
        >
          <ArrowLeft className={ICON} />
        </button>
      )}
      {next && (
        <button
          type="button"
          title={`Move to ${next}`}
          className={BTN}
          onClick={() => run(() => onMove(task.slug, next))}
        >
          <ArrowRight className={ICON} />
        </button>
      )}
      {task.status !== 'archived' && (
        <button type="button" title="Archive" className={BTN} onClick={() => run(() => onArchive(task.slug))}>
          <Archive className={ICON} />
        </button>
      )}
      <button
        type="button"
        title="Delete"
        className="ml-auto p-1 text-destructive/70 hover:text-destructive transition-colors"
        onClick={() => run(() => onDelete(task.slug), 'error')}
      >
        <Trash2 className={ICON} />
      </button>
    </div>
  )
}
