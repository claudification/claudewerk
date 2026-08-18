/**
 * Project Board -- the two surfaces over one project's cards.
 *
 * BOARD is where work MOVES (kanban lanes, grouped); EPICS is where work is
 * READ (an index and a detail pane). Neither grows the other's job: any list of
 * cards lives on the board, any prose about an epic lives in the pane.
 *
 * This file is the orchestrator only. It was 795 lines of god component before
 * grouping landed; the split is by RESPONSIBILITY, not line count -- filtering
 * is `use-board-filters`, mutations and modals are `use-card-actions`, chrome
 * is `board-header`, and the kanban is `board-lanes`.
 */

import { buildEpicIndex, splitUnparented } from '@shared/epic-cards'
import { memo, useMemo, useState } from 'react'
import { useBoardViewConfig } from '@/hooks/use-board-view-config'
import { useCardDeepLink } from '@/hooks/use-card-deeplink'
import { type ProjectTaskMeta, useProject } from '@/hooks/use-project'
import { BoardArchiveDrawer } from './project-board/board-archive-drawer'
import { BoardHeader } from './project-board/board-header'
import { BoardLanes } from './project-board/board-lanes'
import { BoardModals } from './project-board/board-modals'
import { EpicRibbon } from './project-board/epic-ribbon'
import { EpicsView } from './project-board/epics-view'
import { ProjectCard } from './project-board/project-card'
import { useBoardFilters } from './project-board/use-board-filters'
import { useCardActions } from './project-board/use-card-actions'
import { openTaskBatch } from './task-batch-trigger'

export const ProjectBoard = memo(function ProjectBoard({ conversationId }: { conversationId: string }) {
  const project = useProject(conversationId)
  const { projectUri, tasks, loading, refresh, moveTask, updateTask } = project
  const [configOpen, setConfigOpen] = useState(false)
  const { config: view, update: updateView, reset: resetView } = useBoardViewConfig()

  // One fold over the cards the board already holds -- no extra I/O, and the
  // lane cards and the EPICS view read the same numbers by construction.
  const epicIndex = useMemo(() => buildEpicIndex(tasks), [tasks])
  const filters = useBoardFilters(tasks)
  const actions = useCardActions(project, epicIndex, conversationId)

  // Deep links (push notification, #task/<id>, a `.rclaude/project/...` markdown
  // link) -- resolved by slug once the manifest has landed. See the hook.
  useCardDeepLink({ ready: !!projectUri, readTask: project.readTask, onOpen: actions.setEditingTask })

  // The ribbon's trailing count is LIVE unparented only. Counting the archive
  // there is what made "no epic" read as an alarm instead of as a bucket.
  const looseLive = useMemo(() => splitUnparented(tasks, epicIndex).live.length, [tasks, epicIndex])
  const rollups = useMemo(() => [...epicIndex.values()], [epicIndex])

  /** One card, wired to the board's handlers. Same everywhere it renders --
   *  the columns and the archive drawer must not drift apart. */
  const renderCard = useMemo(
    () => (task: ProjectTaskMeta) => (
      <ProjectCard
        key={task.slug}
        task={task}
        view={view}
        epicIndex={epicIndex}
        onMove={actions.move}
        onDelete={actions.remove}
        onArchive={actions.archive}
        onEdit={meta => void actions.openCardBySlug(meta.slug)}
        onOpenSlug={slug => void actions.openCardBySlug(slug)}
      />
    ),
    [view, epicIndex, actions],
  )

  /**
   * TRIAGE hands the loose pile to the board, grouped by tag. The triage tool
   * IS the board -- an index row cannot move 138 cards, and building a second
   * bulk-edit surface to do it would be the mode toggle all over again.
   */
  function triage() {
    filters.setSelectedEpic(null)
    updateView('groupBy', 'tag')
    updateView('view', 'board')
  }

  const archivedTasks = filters.filtered.filter(n => n.status === 'archived')
  const activeTasks = filters.filtered.filter(n => n.status !== 'archived')
  const onBoard = view.view === 'board'

  if (loading && tasks.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted-foreground/80 text-read font-mono">Loading…</div>
    )
  }

  return (
    <div className="h-full flex flex-col">
      <BoardHeader
        conversationId={conversationId}
        view={view}
        update={updateView}
        reset={resetView}
        tabCounts={{ board: tasks.length, epics: epicIndex.size }}
        configOpen={configOpen}
        onToggleConfig={() => setConfigOpen(v => !v)}
        onBatch={() => openTaskBatch({ conversationId })}
        onRefresh={() => refresh()}
        filters={filters}
      />

      {onBoard && view.groupBy === 'epic' && (
        <EpicRibbon
          rollups={rollups}
          selected={filters.selectedEpic}
          looseCount={looseLive}
          onSelect={filters.setSelectedEpic}
        />
      )}

      {onBoard ? (
        <BoardLanes
          tasks={activeTasks}
          view={view}
          epicIndex={epicIndex}
          renderCard={renderCard}
          onMove={actions.move}
          onCreate={actions.create}
        />
      ) : (
        <EpicsView
          tasks={filters.filtered}
          onOpenCard={actions.openCardBySlug}
          onWorkOnEpic={actions.workOnEpic}
          onEpicMode={actions.epicMode}
          onTriage={triage}
        />
      )}

      {onBoard && <BoardArchiveDrawer tasks={archivedTasks} renderCard={renderCard} />}

      <BoardModals
        conversationId={conversationId}
        editingTask={actions.editingTask}
        setEditingTask={actions.setEditingTask}
        runTask={actions.runTask}
        setRunTask={actions.setRunTask}
        moveTask={moveTask}
        updateTask={updateTask}
      />
    </div>
  )
})

export { RunTaskDialog } from './project-board/run-task-dialog'
// Split out 2026-08-14 (this file was 1766 LOC). Re-exported here because both
// are imported from '../project-board' by TaskEditorOverlay and by tests.
export { TaskEditor } from './project-board/task-editor'
