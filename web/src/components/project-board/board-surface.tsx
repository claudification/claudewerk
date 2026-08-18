/**
 * The BOARD half of the project board: the epic ribbon, the kanban lanes, and
 * the archive drawer under them.
 *
 * These three always appear together and always disappear together -- they were
 * three separate `view.view === 'board' &&` gates in the orchestrator, plus the
 * archived/active split that only this half consumes. One surface, one gate.
 */

import type { EpicRollup } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import type { BoardViewConfig } from '@/hooks/use-board-view-config'
import type { TaskStatus } from '@/hooks/use-project'
import { BoardArchiveDrawer } from './board-archive-drawer'
import { BoardLanes } from './board-lanes'
import { EpicRibbon } from './epic-ribbon'
import type { CardRenderer } from './use-card-renderer'

export function BoardSurface({
  tasks,
  view,
  epicIndex,
  rollups,
  selectedEpic,
  onSelectEpic,
  looseLive,
  renderCard,
  onMove,
  onCreate,
}: {
  /** Already filtered; the archived/active split happens here. */
  tasks: ProjectTaskMeta[]
  view: BoardViewConfig
  epicIndex: Map<string, EpicRollup>
  rollups: EpicRollup[]
  selectedEpic: string | null
  onSelectEpic: (epicId: string | null) => void
  /** LIVE unparented only -- counting the archive here made "no epic" read as
   *  an alarm instead of as a bucket. */
  looseLive: number
  renderCard: CardRenderer
  onMove: (slug: string, to: TaskStatus) => void
  onCreate: (text: string) => Promise<void>
}) {
  const archived = tasks.filter(t => t.status === 'archived')
  const active = tasks.filter(t => t.status !== 'archived')

  return (
    <>
      {view.groupBy === 'epic' && (
        <EpicRibbon rollups={rollups} selected={selectedEpic} looseCount={looseLive} onSelect={onSelectEpic} />
      )}
      <BoardLanes
        tasks={active}
        view={view}
        epicIndex={epicIndex}
        renderCard={renderCard}
        onMove={onMove}
        onCreate={onCreate}
      />
      <BoardArchiveDrawer tasks={archived} renderCard={renderCard} />
    </>
  )
}
