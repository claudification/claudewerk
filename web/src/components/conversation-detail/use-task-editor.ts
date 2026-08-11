import { useEffect, useState } from 'react'
import { useCardResolver } from '@/hooks/use-card-deeplink'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type ProjectTask, useProject } from '@/hooks/use-project'

export function useTaskEditor(selectedConversationId: string | null) {
  const pendingTaskEdit = useConversationsStore(s => s.pendingTaskEdit)
  const { tasks: projectTasks, loading, readTask, updateTask, moveTask } = useProject(selectedConversationId)
  const [taskEditorTask, setTaskEditorTask] = useState<ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<ProjectTask | null>(null)

  // The card opens on its own -- no board behind it, and no lane to get wrong.
  const requestCard = useCardResolver({ tasks: projectTasks, loading, readTask, onOpen: setTaskEditorTask })
  useEffect(() => {
    if (!pendingTaskEdit) return
    useConversationsStore.getState().setPendingTaskEdit(null)
    requestCard(pendingTaskEdit.slug)
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
