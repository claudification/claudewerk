import { useEffect, useState } from 'react'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type ProjectTask, type TaskStatus, useProject } from '@/hooks/use-project'

export function useTaskEditor(selectedConversationId: string | null) {
  const pendingTaskEdit = useConversationsStore(s => s.pendingTaskEdit)
  const { tasks: projectTasks, readTask, updateTask, moveTask } = useProject(selectedConversationId)
  const [taskEditorTask, setTaskEditorTask] = useState<ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<ProjectTask | null>(null)

  useEffect(() => {
    if (!pendingTaskEdit) return
    useConversationsStore.getState().setPendingTaskEdit(null)
    readTask(pendingTaskEdit.slug, pendingTaskEdit.status as TaskStatus).then(full => {
      if (full) setTaskEditorTask(full)
    })
  }, [pendingTaskEdit, readTask])

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
