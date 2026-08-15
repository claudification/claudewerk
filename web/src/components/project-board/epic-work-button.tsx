/**
 * The one action an epic offers, and an honest reason when it offers none.
 *
 * A disabled button with no explanation is the failure this avoids: "work" was
 * greyed out identically for an epic with seven cards in review and an epic
 * with no cards at all, which are opposite problems.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { Play, Plus } from 'lucide-react'
import { cn, haptic } from '@/lib/utils'

type Shape = { kind: 'start'; label: string } | { kind: 'adopt'; label: string } | { kind: 'idle'; label: string }

/** What this epic can actually offer right now. */
export function workShape(rollup: EpicRollup): Shape {
  if (rollup.notStarted > 0) {
    return { kind: 'start', label: `work ${rollup.notStarted} card${rollup.notStarted === 1 ? '' : 's'}` }
  }
  if (rollup.children.length === 0) return { kind: 'adopt', label: 'adopt cards' }
  if (rollup.inProgress > 0) return { kind: 'idle', label: `${rollup.inProgress} already moving` }
  return { kind: 'idle', label: 'all done' }
}

export function EpicWorkButton({
  rollup,
  onWork,
  onAdopt,
}: {
  rollup: EpicRollup
  onWork: (epicId: string) => void
  onAdopt?: (epicId: string) => void
}) {
  const shape = workShape(rollup)
  const disabled = shape.kind === 'idle'
  const Icon = shape.kind === 'adopt' ? Plus : Play

  return (
    <button
      type="button"
      disabled={disabled}
      title={shape.kind === 'start' ? `Launch the ${rollup.notStarted} not-started card(s)` : shape.label}
      onClick={() => {
        if (disabled) return
        haptic('tap')
        if (shape.kind === 'adopt') onAdopt?.(rollup.epicId)
        else onWork(rollup.epicId)
      }}
      className={cn(
        'shrink-0 flex items-center gap-1 px-2 py-1 text-[10px] font-mono border transition-colors',
        disabled
          ? 'border-border/25 text-muted-foreground/40 cursor-not-allowed'
          : 'border-[color:var(--epic-edge)] text-[color:var(--epic-solid)] hover:bg-[color:var(--epic-tint)]',
      )}
    >
      {!disabled && <Icon className="size-2.5" />}
      {shape.label}
    </button>
  )
}
