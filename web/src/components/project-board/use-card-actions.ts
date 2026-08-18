/**
 * Card mutations and the two modals they open.
 *
 * The editor and the run dialog are owned here rather than in `ProjectBoard`
 * because they are the same job as the mutations that feed them: open a card,
 * change it, move it, run it. Splitting the state from the callbacks that drive
 * it is what left the board component holding eight `useState`s it never read.
 */

import { epicBatchPayload } from '@shared/epic-batch'
import type { EpicRollup } from '@shared/epic-cards'
import type { TaskMode } from '@shared/task-modes'
import { useCallback, useEffect, useState } from 'react'
import type { ProjectTask, ProjectTaskMeta, TaskStatus } from '@/hooks/use-project'
import { openTaskBatch } from '../task-batch-trigger'

/** The slice of `useProject` this hook drives. Structural on purpose -- the
 *  hook must not care what else the project API carries. */
interface ProjectApi {
  createTask: (input: { title?: string; body: string; priority?: string; tags?: string[] }) => Promise<unknown>
  moveTask: (id: string, to: TaskStatus) => Promise<unknown>
  deleteTask: (id: string) => Promise<unknown>
  readTask: (slug: string) => Promise<ProjectTask | null>
  tasks: ProjectTaskMeta[]
}

export function useCardActions(api: ProjectApi, epicIndex: Map<string, EpicRollup>, conversationId: string) {
  const [editingTask, setEditingTask] = useState<ProjectTask | null>(null)
  const [runTask, setRunTask] = useState<ProjectTask | null>(null)
  const { createTask, moveTask, deleteTask, readTask, tasks } = api

  // Keep an open editor's metadata in step when the list changes underneath it
  // (e.g. `project_changed` from another conversation). Body text is left alone
  // so a refresh never clobbers what someone is typing.
  useEffect(() => {
    if (!editingTask) return
    const updated = tasks.find(t => t.slug === editingTask.slug)
    if (updated && (updated.status !== editingTask.status || updated.priority !== editingTask.priority)) {
      setEditingTask(prev =>
        prev ? { ...prev, status: updated.status, priority: updated.priority, tags: updated.tags } : prev,
      )
    }
  }, [tasks, editingTask])

  const openCardBySlug = useCallback(
    async (slug: string) => {
      const full = await readTask(slug)
      if (full) setEditingTask(full)
    },
    [readTask],
  )

  const create = useCallback(
    async (text: string) => {
      const lines = text.split('\n')
      const body = lines.length > 1 ? lines.slice(1).join('\n').trim() : text
      await createTask({ title: lines[0], body })
    },
    [createTask],
  )

  const move = useCallback(async (id: string, to: TaskStatus) => void (await moveTask(id, to)), [moveTask])
  const remove = useCallback(async (id: string) => void (await deleteTask(id)), [deleteTask])
  const archive = useCallback(async (id: string) => void (await moveTask(id, 'archived')), [moveTask])

  /**
   * Hand the EXISTING batch selector this epic's cards, ticked and on the right
   * template. WORK ticks the not-started ones; REFINE and ANALYZE tick
   * everything still live -- `epicBatchPayload` owns that decision.
   *
   * The board's own conversation rides along: the selector otherwise reads and
   * sends against the app's SELECTED conversation, which is a different project
   * whenever the board was opened for one (a detached board makes that the
   * normal case, not the edge one).
   */
  const epicMode = useCallback(
    (epicId: string, mode: TaskMode) => {
      const rollup = epicIndex.get(epicId)
      if (rollup) openTaskBatch({ ...epicBatchPayload(rollup, mode), conversationId })
    },
    [epicIndex, conversationId],
  )

  const workOnEpic = useCallback((epicId: string) => epicMode(epicId, 'work'), [epicMode])

  return {
    editingTask,
    setEditingTask,
    runTask,
    setRunTask,
    openCardBySlug,
    create,
    move,
    remove,
    archive,
    epicMode,
    workOnEpic,
  }
}
