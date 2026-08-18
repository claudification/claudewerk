/**
 * The EPICS view: an index that RANKS, a pane that READS.
 *
 * It used to be a vertical stack of swimlanes, each carrying a title, a bar,
 * four counts, a body paragraph, tags and refs. Seven epics filled the screen
 * with headers and answered nothing. Now an epic is one row until you pick it,
 * and only the picked one is expensive.
 *
 * On a narrow screen the two halves are separate screens: the index, then the
 * pane with a back arrow. Two panes at 375px would be two unreadable panes.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { TaskMode } from '@shared/task-modes'
import { useMemo, useState } from 'react'
import type { ProjectTaskMeta } from '@/hooks/use-project'
import type { EpicRunState } from '@/lib/epic-run-api'
import { cn } from '@/lib/utils'
import { AllocationStrip } from './allocation-strip'
import { EpicDetailPane } from './epic-detail-pane'
import { EpicIndex } from './epic-index'
import { EpicRunDialog } from './epic-run-dialog'
import { type EpicSort, EpicsToolbar } from './epics-toolbar'
import { useEpicViewModel } from './use-epic-view-model'

function priorityBreakdown(cards: ProjectTaskMeta[]): string {
  const counts = { high: 0, medium: 0, low: 0, unset: 0 }
  for (const c of cards) {
    const key = c.priority && c.priority in counts ? (c.priority as keyof typeof counts) : 'unset'
    counts[key] += 1
  }
  return `${counts.high} high · ${counts.medium} medium · ${counts.low} low · ${counts.unset} unset`
}

function statusBreakdown(cards: ProjectTaskMeta[]): string {
  const done = cards.filter(c => c.status === 'done').length
  return `${done} done + ${cards.length - done} archived -- nobody is parenting these`
}

export function EpicsView({
  tasks,
  onOpenCard,
  onWorkOnEpic,
  onEpicMode,
  onTriage,
  onAdopt,
}: {
  tasks: ProjectTaskMeta[]
  onOpenCard: (slug: string) => void
  onWorkOnEpic: (epicId: string) => void
  onEpicMode: (epicId: string, mode: TaskMode) => void
  /** Hand the loose pile to the board, grouped so it can actually be triaged. */
  onTriage: () => void
  /** Write `epic: <id>` onto a card. Absent => the linked section stays hidden
   *  rather than offering an ADOPT button with nothing behind it. Returns
   *  `unknown` so the board can pass `setCardEpic` straight through instead of
   *  wrapping it only to discard a value nobody reads. */
  onAdopt?: (slug: string, epicId: string) => Promise<unknown>
}) {
  const [selected, setSelected] = useState<string | null>(null)
  // The RUN dialog lives here rather than in the button so it survives the
  // button unmounting when the pane re-renders mid-arm. It keeps the epic ID
  // rather than the rollup so the dialog's briefing tracks a board that changes
  // underneath it -- an epic whose last card finishes mid-decision should not
  // still be advertising it as ready.
  const [runDialog, setRunDialog] = useState<{
    epicId: string
    run: EpicRunState | null
    project: string | null
  } | null>(null)
  const [sort, setSort] = useState<EpicSort>('urgency')
  const [showComplete, setShowComplete] = useState(true)

  const { rollups, loose, withWork, empty, current, links } = useEpicViewModel(tasks, sort, showComplete, selected)
  const running: EpicRollup | undefined = rollups.find(r => r.epicId === runDialog?.epicId)

  // Bound to the selected epic here rather than in the JSX -- the pane only
  // knows a slug, the write needs both, and a ternary inside a prop is the
  // least readable place to say so.
  const adoptInto = onAdopt && current ? async (slug: string) => void (await onAdopt(slug, current.epicId)) : undefined

  if (rollups.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-40 gap-1">
        <div className="text-read font-mono text-muted-foreground/80">No epics on this board</div>
        <div className="text-meta font-mono text-muted-foreground/60">
          tag a card `epic`, then put `epic: &lt;that-id&gt;` on its children
        </div>
      </div>
    )
  }

  return (
    <div className="flex-1 min-h-0 flex flex-col">
      <AllocationStrip
        rollups={rollups}
        liveLoose={loose.live.length}
        finishedLoose={loose.finished.length}
        total={tasks.length}
      />

      <EpicsToolbar
        epicCount={rollups.length}
        parentedCount={rollups.reduce((n, r) => n + r.children.length, 0)}
        looseLiveCount={loose.live.length}
        sort={sort}
        onSort={setSort}
        showComplete={showComplete}
        onShowComplete={setShowComplete}
      />

      <div className="flex-1 min-h-0 md:grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.02fr)]">
        {/* On mobile the index hides once an epic is picked -- the pane takes the screen. */}
        <div className={cn('h-full min-h-0 flex flex-col md:border-r md:border-border', current && 'hidden md:flex')}>
          <EpicIndex
            withWork={withWork}
            empty={empty}
            selected={selected}
            liveCount={loose.live.length}
            liveDetail={priorityBreakdown(loose.live)}
            finishedCount={loose.finished.length}
            finishedDetail={statusBreakdown(loose.finished)}
            onSelect={id => setSelected(prev => (prev === id ? null : id))}
            onTriage={onTriage}
          />
        </div>

        <div className={cn('h-full min-h-0 flex flex-col', !current && 'hidden md:flex')}>
          {current ? (
            <EpicDetailPane
              key={current.epicId}
              rollup={current}
              onOpenCard={onOpenCard}
              onWorkOnEpic={onWorkOnEpic}
              onEpicMode={onEpicMode}
              onRunEpic={(epicId, run, project) => setRunDialog({ epicId, run, project })}
              onBack={() => setSelected(null)}
              links={links}
              onAdopt={adoptInto}
            />
          ) : (
            <div className="flex-1 flex items-center justify-center px-6 text-center">
              <p className="font-mono text-meta text-muted-foreground/60 max-w-[30ch]">
                Pick an epic to read it -- its body, refs and every card under it.
              </p>
            </div>
          )}
        </div>
      </div>

      {runDialog && running && (
        <EpicRunDialog
          rollup={running}
          project={runDialog.project}
          existing={runDialog.run}
          onClose={() => setRunDialog(null)}
          onStarted={() => setRunDialog(null)}
        />
      )}
    </div>
  )
}
