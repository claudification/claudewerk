/**
 * The EPICS view: a listing of epics in detail, plus an honest count of
 * everything that belongs to none.
 *
 * That last part is not decoration. Mid-adoption most of a board is unparented,
 * and a view that silently showed only the organised 5% would read as "this is
 * the work" when it is a rounding error of it.
 */

import { buildEpicIndex, unparentedCards } from '@shared/epic-cards'
import { useMemo, useState } from 'react'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { sortEpics } from './epic-sorts'
import { EpicSwimlane } from './epic-swimlane'
import { type EpicSort, EpicsToolbar } from './epics-toolbar'

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
  const [sort, setSort] = useState<EpicSort>('urgency')
  const [showComplete, setShowComplete] = useState(true)

  const { rollups, unparentedCount, parentedCount } = useMemo(() => {
    const index = buildEpicIndex(tasks)
    const all = [...index.values()]
    return {
      rollups: all,
      parentedCount: all.reduce((n, r) => n + r.children.length, 0),
      unparentedCount: unparentedCards(tasks, index).length,
    }
  }, [tasks])

  const visible = useMemo(
    () => sortEpics(showComplete ? rollups : rollups.filter(r => !r.complete), sort),
    [rollups, sort, showComplete],
  )

  const allExpanded = visible.length > 0 && visible.every(r => expanded.has(r.epicId))

  function toggle(epicId: string) {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(epicId)) next.delete(epicId)
      else next.add(epicId)
      return next
    })
  }

  function toggleAll() {
    setExpanded(allExpanded ? new Set() : new Set(visible.map(r => r.epicId)))
  }

  if (rollups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-1">
        <div className="text-xs font-mono text-muted-foreground/50">No epics on this board</div>
        <div className="text-[10px] font-mono text-muted-foreground/35">
          tag a card `epic`, then put `epic: &lt;that-id&gt;` on its children
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <EpicsToolbar
        epicCount={rollups.length}
        parentedCount={parentedCount}
        unparentedCount={unparentedCount}
        sort={sort}
        onSort={setSort}
        showComplete={showComplete}
        onShowComplete={setShowComplete}
        allExpanded={allExpanded}
        onToggleAll={toggleAll}
      />

      <div className="flex-1 min-h-0 overflow-y-auto">
        {visible.map(rollup => (
          <EpicSwimlane
            key={rollup.epicId}
            rollup={rollup}
            expanded={expanded.has(rollup.epicId)}
            onToggle={toggle}
            onOpenCard={onOpenCard}
            onWorkOnEpic={onWorkOnEpic}
          />
        ))}
        {visible.length === 0 && (
          <div className="px-3 py-6 text-center text-[11px] font-mono text-muted-foreground/40">
            every epic is finished -- turn on `show finished` to see them
          </div>
        )}
      </div>

      {unparentedCount > 0 && (
        <button
          type="button"
          onClick={() => haptic('tap')}
          className="w-full flex items-center gap-2 px-3 py-2 text-left border-t border-border/60 shrink-0"
        >
          <span className="text-[10px] font-mono text-event-prompt/70">⚠</span>
          <span className="text-[10px] font-mono text-muted-foreground/70">{unparentedCount} cards</span>
          <span className="text-[10px] font-mono text-muted-foreground/45">belong to no epic</span>
        </button>
      )}
    </div>
  )
}
