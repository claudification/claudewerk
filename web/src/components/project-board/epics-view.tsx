/**
 * The EPICS view: one swimlane per epic, plus an honest count of everything
 * that belongs to none.
 *
 * That last part is not decoration. Mid-adoption most of a board is unparented,
 * and a view that silently showed only the organised 6% would read as "this is
 * the work" when it is a rounding error of it.
 */

import type { EpicRollup } from '@shared/epic-cards'
import { buildEpicIndex, unparentedCards } from '@shared/epic-cards'
import { useMemo, useState } from 'react'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { EpicSwimlane } from './epic-swimlane'

/** Epics with work outstanding first, then by how far along they are. */
function byUrgency(a: EpicRollup, b: EpicRollup): number {
  const openDiff = b.notStarted + b.inProgress - (a.notStarted + a.inProgress)
  if (openDiff !== 0) return openDiff
  return (b.pct ?? -1) - (a.pct ?? -1)
}

export function EpicsView({
  tasks,
  onOpenCard,
  onWorkOnEpic,
}: {
  tasks: ProjectTaskMeta[]
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
}) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())

  const { rollups, unparentedCount } = useMemo(() => {
    const index = buildEpicIndex(tasks)
    return {
      rollups: [...index.values()].toSorted(byUrgency),
      unparentedCount: unparentedCards(tasks, index).length,
    }
  }, [tasks])

  function toggle(epicId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(epicId)) next.delete(epicId)
      else next.add(epicId)
      return next
    })
  }

  if (rollups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-1">
        <div className="text-xs font-mono text-muted-foreground/40">No epics on this board</div>
        <div className="text-[10px] font-mono text-muted-foreground/25">
          tag a card `epic`, then put `epic: &lt;that-id&gt;` on its children
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 overflow-y-auto">
      {rollups.map(rollup => (
        <EpicSwimlane
          key={rollup.epicId}
          rollup={rollup}
          expanded={expanded.has(rollup.epicId)}
          onToggle={toggle}
          onOpenCard={onOpenCard}
          onWorkOnEpic={onWorkOnEpic}
        />
      ))}
      {unparentedCount > 0 && (
        <button
          type="button"
          onClick={() => haptic('tap')}
          className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-primary/12"
        >
          <span className="text-[10px] font-mono text-muted-foreground/40">UNPARENTED</span>
          <span className="text-[10px] font-mono text-muted-foreground/60">{unparentedCount} cards</span>
          <span className="ml-auto text-[9px] font-mono text-muted-foreground/25">belong to no epic</span>
        </button>
      )}
    </div>
  )
}
