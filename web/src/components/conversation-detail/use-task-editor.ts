import { useEffect, useState } from 'react'
import { useCardResolver } from '@/hooks/use-card-deeplink'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type ProjectTask, type TaskStatus, useProject } from '@/hooks/use-project'

export function useTaskEditor(selectedConversationId: string | null) {
  const pendingTaskEdit = useConversationsStore(s => s.pendingTaskEdit)
  const { tasks: projectTasks, loading, readTask, updateTask, moveTask } = useProject(selectedConversationId)
  const [taskEditorTask, setTaskEditorTask] = useState<ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<ProjectTask | null>(null)

  // The card opens on its own -- no board behind it. The lane is a hint: a card
  // link outlives the card's stay in a lane, so the resolver may correct it.
  const requestCard = useCardResolver({ tasks: projectTasks, loading, readTask, onOpen: setTaskEditorTask })
  useEffect(() => {
    if (!pendingTaskEdit) return
    useConversationsStore.getState().setPendingTaskEdit(null)
    requestCard(pendingTaskEdit.slug, (pendingTaskEdit.status as TaskStatus) || undefined)
  }, [pendingTaskEdit, requestCard])

  useEffect(() => {
    if (!taskEditorTask) return
    const updated = projectTasks.find(t => t.slug === taskEditorTask.slug)
    if (updated && (updated.status !== taskEditorTask.status || updated.priority !== taskEditorTask.priority)) {
      setTaskEditorTask(prev =>
        prev ? { ...prev, status: updated.status, priority: updated.priority, tags: updated.tags } : prev,
      )
    }
  }, [projectTasks, taskEditorTask])

  return {
    taskEditorTask,
    runTaskFromEditor,
    updateTask,
    moveTask,
    setRunTaskFromEditor,
    setTaskEditorTask,
  }
}
