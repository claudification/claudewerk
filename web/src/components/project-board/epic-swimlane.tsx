/**
 * One epic as a row in the EPICS view: header always, three bucket columns when
 * expanded.
 *
 * The WORK button is the point of the whole view -- it hands the launcher this
 * epic's not-started children, pre-selected, instead of making someone
 * rediscover them one card at a time.
 */

import type { EpicBucket, EpicChild, EpicRollup } from '@shared/epic-cards'
import { ChevronDown, ChevronRight, Play } from 'lucide-react'
import { cn, haptic } from '@/lib/utils'
import { EpicChildRow } from './epic-child-row'
import { EpicBucketCounts, EpicProgressBar, EpicProgressLabel } from './epic-progress'

const COLUMNS: Array<{ bucket: EpicBucket; label: string }> = [
  { bucket: 'notStarted', label: 'NOT STARTED' },
  { bucket: 'inProgress', label: 'IN PROGRESS' },
  { bucket: 'done', label: 'DONE' },
]

function bucketChildren(children: EpicChild[], bucket: EpicBucket): EpicChild[] {
  return children.filter(c => c.bucket === bucket)
}

export function EpicSwimlane({
  rollup,
  expanded,
  onToggle,
  onOpenCard,
  onWorkOnEpic,
}: {
  rollup: EpicRollup
  expanded: boolean
  onToggle: (epicId: string) => void
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
}) {
  const title = rollup.card?.title ?? rollup.epicId
  const Chevron = expanded ? ChevronDown : ChevronRight
  const startable = rollup.notStarted > 0

  return (
    <div className="border-b border-primary/8">
      <div className="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            onToggle(rollup.epicId)
          }}
          className="flex items-center gap-2 flex-1 min-w-0 text-left"
        >
          <Chevron className="size-3.5 text-muted-foreground/40 shrink-0" />
          <span className="text-accent/70 text-xs shrink-0">◈</span>
          <span className="text-xs font-mono text-foreground truncate">{title}</span>
        </button>
        <div className="w-32 shrink-0 hidden sm:block">
          <EpicProgressBar rollup={rollup} />
        </div>
        <div className="shrink-0">
          <EpicProgressLabel rollup={rollup} />
        </div>
        <button
          type="button"
          disabled={!startable}
          title={startable ? `Work on the ${rollup.notStarted} not-started card(s)` : 'Nothing left to start'}
          onClick={() => {
            haptic('tap')
            onWorkOnEpic(rollup.epicId)
          }}
          className={cn(
            'shrink-0 flex items-center gap-1 px-1.5 py-0.5 text-[9px] font-mono border transition-colors',
            startable
              ? 'border-accent/40 text-accent hover:bg-accent/10'
              : 'border-border/20 text-muted-foreground/25 cursor-not-allowed',
          )}
        >
          <Play className="size-2.5" />
          work
        </button>
      </div>

      {!expanded && rollup.children.length === 0 && (
        <div className="px-3 pb-2 text-[10px] font-mono text-muted-foreground/30">
          no children yet -- tagged `epic`, nothing points at it
        </div>
      )}

      {expanded && (
        <div className="px-3 pb-3 space-y-2">
          <EpicBucketCounts rollup={rollup} />
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
            {COLUMNS.map(col => {
              const items = bucketChildren(rollup.children, col.bucket)
              return (
                <div key={col.bucket} className="border border-primary/10 p-1.5 min-w-0">
                  <div className="text-[9px] font-mono text-muted-foreground/40 mb-1">
                    {col.label} {items.length}
                  </div>
                  {items.length === 0 ? (
                    <div className="text-[9px] font-mono text-muted-foreground/20">--</div>
                  ) : (
                    items.map(child => <EpicChildRow key={child.card.slug} child={child} onOpen={onOpenCard} />)
                  )}
                </div>
              )
            })}
          </div>
          {rollup.dropped > 0 && (
            <div className="text-[9px] font-mono text-muted-foreground/30">
              ⊘ {rollup.dropped} dropped -- excluded from the percentage
            </div>
          )}
        </div>
      )}
    </div>
  )
}
