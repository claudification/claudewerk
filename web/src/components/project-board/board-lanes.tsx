/**
 * The kanban surface: drag context, the five columns, the drag preview.
 *
 * Split out of `project-board.tsx` (795 LOC) when grouping landed. Everything
 * here is about MOVING work; reading an epic lives in the EPICS view.
 */

import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core'
import type { EpicRollup } from '@shared/epic-cards'
import type { ProjectTaskMeta } from '@shared/project-task-types'
import { useMemo, useState } from 'react'
import type { BoardViewConfig } from '@/hooks/use-board-view-config'
import type { TaskStatus } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { TASK_COLUMNS } from './board-constants'
import { groupCards, tagFrequencyRank } from './board-grouping'
import { BoardLaneColumn } from './board-lane-column'
import { InlineAdd } from './inline-add'

export function BoardLanes({
  tasks,
  view,
  epicIndex,
  renderCard,
  onMove,
  onCreate,
}: {
  /** Active (non-archived) cards, already filtered. */
  tasks: ProjectTaskMeta[]
  view: BoardViewConfig
  epicIndex: Map<string, EpicRollup>
  renderCard: (task: ProjectTaskMeta) => React.ReactNode
  onMove: (slug: string, to: TaskStatus) => void
  onCreate: (text: string) => Promise<void>
}) {
  const [activeDragTask, setActiveDragTask] = useState<ProjectTaskMeta | null>(null)

  // Rank once for the whole board, not once per column -- grouping by tag
  // clusters on how common a tag is BOARD-wide, so a per-column rank would put
  // the same card under different heads in different lanes.
  const tagRank = useMemo(() => tagFrequencyRank(tasks), [tasks])

  const groupsByStatus = useMemo(() => {
    const out = new Map<TaskStatus, ReturnType<typeof groupCards>>()
    for (const col of TASK_COLUMNS) {
      const inLane = tasks.filter(t => t.status === col.status)
      out.set(col.status, groupCards(inLane, view.groupBy, epicIndex, tagRank))
    }
    return out
  }, [tasks, view.groupBy, epicIndex, tagRank])

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 300, tolerance: 5 } }),
  )

  function handleDragStart(event: DragStartEvent) {
    const data = event.active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!data) return
    const task = tasks.find(n => n.slug === data.slug && n.status === data.status)
    if (task) setActiveDragTask(task)
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveDragTask(null)
    const { active, over } = event
    if (!over) return
    const targetStatus = over.id as TaskStatus
    const sourceData = active.data.current as { slug: string; status: TaskStatus } | undefined
    if (!sourceData || sourceData.status === targetStatus) return
    haptic('tap')
    onMove(sourceData.slug, targetStatus)
  }

  return (
    <DndContext sensors={sensors} onDragStart={handleDragStart} onDragEnd={handleDragEnd}>
      <div className="flex-1 min-h-0 overflow-x-auto overflow-y-hidden">
        <div className="flex gap-0 h-full min-w-max">
          {TASK_COLUMNS.map(col => (
            <BoardLaneColumn
              key={col.status}
              status={col.status}
              label={col.label}
              labelClass={col.color}
              width={view.columnWidth}
              groups={groupsByStatus.get(col.status) ?? []}
              epicIndex={epicIndex}
              renderCard={renderCard}
              footer={col.status === 'inbox' ? <InlineAdd onAdd={onCreate} /> : undefined}
            />
          ))}
        </div>
      </div>
      <DragOverlay dropAnimation={null}>
        {activeDragTask && (
          <div className="px-3 py-2 bg-surface-inset border border-primary/25 shadow-xl opacity-90 max-w-[250px]">
            <div className="text-read font-mono text-foreground truncate">{activeDragTask.title}</div>
            {activeDragTask.bodyPreview && (
              <div className="text-meta text-muted-foreground mt-0.5 line-clamp-2">{activeDragTask.bodyPreview}</div>
            )}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  )
}
