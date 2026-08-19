/**
 * The WORK / REFINE / ANALYZE switch at the top of a card's launch modal, and
 * the config each mode implies.
 *
 * Its own file because `run-task-dialog.tsx` is a 419-line god-component with
 * 13 useState already (flagged there, pre-existing); the modes had no business
 * adding a fourteenth branch to it inline.
 *
 * `modeDefaults` is the part worth testing. Handing an ANALYZE run a worktree
 * branches the repo to produce a report, and handing it auto-commit tells an
 * agent that must change nothing to commit. Both are silent wrong-doing, so
 * the mode picks them rather than inheriting whatever the last WORK run saved.
 */

import { TASK_MODES, type TaskMode, taskMode } from '@shared/task-modes'
import { cn, haptic } from '@/lib/utils'

export interface ModeDefaults {
  useWorktree: boolean
  autoCommit: boolean
}

/**
 * What a mode implies for the lifecycle switches. WORK is the only mode that
 * keeps the user's saved defaults -- it is the only one that writes code.
 */
export function modeDefaults(mode: TaskMode, saved: ModeDefaults): ModeDefaults {
  if (mode === 'work') return saved
  // Refine rewrites the card file in place; a worktree would strand that edit
  // on a branch nobody merges. It still commits, because it changed something.
  if (mode === 'refine') return { useWorktree: false, autoCommit: true }
  return { useWorktree: false, autoCommit: false }
}

/** Persisting an analyze run's "no commit, no worktree" would poison the next
 *  real launch, which is why only WORK writes the remembered defaults back. */
export function persistsDefaults(mode: TaskMode): boolean {
  return mode === 'work'
}

export function RunModeTabs({ mode, onChange }: { mode: TaskMode; onChange: (mode: TaskMode) => void }) {
  return (
    <div role="radiogroup" aria-label="What to do with this card" className="flex items-center gap-1">
      {TASK_MODES.map(spec => (
        <button
          key={spec.id}
          type="button"
          role="radio"
          aria-checked={mode === spec.id}
          title={spec.id === 'work' ? 'Build it' : spec.id === 'refine' ? 'Sharpen the card' : 'Report only'}
          onClick={() => {
            haptic('tap')
            onChange(spec.id)
          }}
          className={cn(
            'px-2 py-0.5 text-[10px] font-mono border transition-colors',
            mode === spec.id
              ? 'border-amber-500/40 bg-amber-500/15 text-amber-400 font-bold'
              : 'border-border-subtle text-fg-muted hover:text-foreground hover:border-border',
          )}
        >
          {spec.label}
        </button>
      ))}
    </div>
  )
}

/** Sub-header line: what the selected mode will actually do to the card. */
export function RunModeHint({ mode }: { mode: TaskMode }) {
  const spec = taskMode(mode)
  if (spec.flipsStatus) return null
  return (
    <div className="text-[10px] font-mono text-fg-muted">
      {spec.id === 'refine'
        ? 'rewrites this card, does not implement it -- status unchanged'
        : 'reports only, changes nothing on disk -- status unchanged'}
    </div>
  )
}
