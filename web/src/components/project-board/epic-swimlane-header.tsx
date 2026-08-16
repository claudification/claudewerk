/**
 * The epic's own row: identity, progress, and enough of the card to know what
 * the epic IS without opening it.
 *
 * The body excerpt is the part that was missing. An epic titled "EPIC: Unify
 * spawn surface" tells you the area and nothing about the shape of the work, so
 * every epic read started with a click through to the card.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { TaskMode } from '@shared/task-modes'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { EpicModeButtons } from './epic-mode-buttons'
import { EpicBucketCounts, EpicProgressBar, EpicProgressLabel } from './epic-progress'
import { EpicWorkButton } from './epic-work-button'

const PRIORITY_CLASS: Record<string, string> = {
  high: 'text-event-prompt',
  medium: 'text-muted-foreground/60',
  low: 'text-muted-foreground/60',
}

function excerpt(text: string | undefined, limit = 180): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > limit ? `${flat.slice(0, limit).trimEnd()}…` : flat
}

export function EpicSwimlaneHeader({
  rollup,
  expanded,
  onToggle,
  onWorkOnEpic,
  onEpicMode,
}: {
  rollup: EpicRollup
  expanded: boolean
  onToggle: (epicId: string) => void
  onWorkOnEpic: (epicId: string) => void
  onEpicMode: (epicId: string, mode: TaskMode) => void
}) {
  const card = rollup.card
  const title = card?.title ?? rollup.epicId
  const Chevron = expanded ? ChevronDown : ChevronRight
  const body = excerpt(card?.bodyPreview)
  const tags = (card?.tags ?? []).filter(t => t !== 'epic')

  return (
    <div className="px-3 py-2 space-y-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onToggle(rollup.epicId)}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <Chevron className="size-3.5 text-muted-foreground/60 shrink-0" />
          <span className="text-[color:var(--epic-solid)] text-sm shrink-0">◈</span>
          <span className="text-[13px] font-mono text-foreground truncate">{title}</span>
          {card?.priority && (
            <span className={cn('text-[10px] font-mono shrink-0', PRIORITY_CLASS[card.priority])}>{card.priority}</span>
          )}
          <span className="text-[10px] font-mono text-muted-foreground/60 shrink-0 hidden md:inline">
            {rollup.epicId}
          </span>
        </button>
        <EpicModeButtons rollup={rollup} onMode={onEpicMode} />
        <EpicWorkButton rollup={rollup} onWork={onWorkOnEpic} />
      </div>

      <div className="flex items-center gap-3 pl-7 flex-wrap">
        <EpicProgressBar rollup={rollup} className="w-28 shrink-0" />
        <EpicProgressLabel rollup={rollup} />
        <EpicBucketCounts rollup={rollup} />
      </div>

      {body && <p className="pl-7 text-[11px] font-mono text-muted-foreground/65 leading-relaxed">{body}</p>}

      {(tags.length > 0 || (card?.refs?.length ?? 0) > 0) && (
        <div className="pl-7 flex items-center gap-x-3 gap-y-1 flex-wrap">
          {tags.length > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/80">
              <span className="text-muted-foreground/60">tags </span>
              {tags.join(' ')}
            </span>
          )}
          {(card?.refs?.length ?? 0) > 0 && (
            <span className="text-[10px] font-mono text-muted-foreground/80 truncate">
              <span className="text-muted-foreground/60">refs </span>
              {card?.refs.join(' · ')}
            </span>
          )}
        </div>
      )}
    </div>
  )
}
