/**
 * REFINE and ANALYZE for a whole epic, next to WORK.
 *
 * An epic could only ever be launched at. Sharpening a dozen half-written cards
 * before spending a fleet on them, or asking for an ordering before committing
 * to one, meant opening the batch selector by hand, re-finding the epic's cards
 * and picking the template -- so nobody did it.
 *
 * Both are read-mostly: refine edits card files, analyze edits nothing. Neither
 * moves a card's status. See `task-modes.ts`.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { TaskMode } from '@shared/task-modes'
import { ClipboardList, Sparkles } from 'lucide-react'
import { cn, haptic } from '@/lib/utils'

/** Cards an epic still has in play. Done and archived are nothing to plan. */
export function liveCount(rollup: EpicRollup): number {
  return rollup.notStarted + rollup.inProgress
}

const MODES: { mode: Exclude<TaskMode, 'work'>; label: string; Icon: typeof Sparkles; verb: string }[] = [
  { mode: 'refine', label: 'refine', Icon: Sparkles, verb: 'Sharpen' },
  { mode: 'analyze', label: 'analyze', Icon: ClipboardList, verb: 'Analyze' },
]

export function EpicModeButtons({
  rollup,
  onMode,
}: {
  rollup: EpicRollup
  onMode: (epicId: string, mode: TaskMode) => void
}) {
  const live = liveCount(rollup)
  const disabled = live === 0

  return (
    <>
      {MODES.map(({ mode, label, Icon, verb }) => (
        <button
          key={mode}
          type="button"
          disabled={disabled}
          title={
            disabled
              ? `Nothing live to ${label} -- every card here is done or archived`
              : `${verb} the ${live} unfinished card${live === 1 ? '' : 's'} in this epic`
          }
          onClick={() => {
            if (disabled) return
            haptic('tap')
            onMode(rollup.epicId, mode)
          }}
          className={cn(
            'shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border transition-colors',
            disabled
              ? 'border-border/45 text-muted-foreground/60 cursor-not-allowed'
              : 'border-border/60 text-muted-foreground hover:text-foreground hover:border-[color:var(--epic-edge)]',
          )}
        >
          {!disabled && <Icon className="size-2.5" />}
          {label}
        </button>
      ))}
    </>
  )
}
