import { useEffect, useState } from 'react'
import { useCardResolver } from '@/hooks/use-card-deeplink'
import { useConversationsStore } from '@/hooks/use-conversations'
import { type ProjectTask, useProject } from '@/hooks/use-project'

export function useTaskEditor(selectedConversationId: string | null) {
  const pendingTaskEdit = useConversationsStore(s => s.pendingTaskEdit)
  const { projectUri, tasks: projectTasks, readTask, updateTask, moveTask } = useProject(selectedConversationId)
  const [taskEditorTask, setTaskEditorTask] = useState<ProjectTask | null>(null)
  const [runTaskFromEditor, setRunTaskFromEditor] = useState<ProjectTask | null>(null)

  // The card opens on its own -- no board behind it, and no lane to get wrong.
  // `ready` is the project, NOT the manifest: the card is read from the board.
  const requestCard = useCardResolver({ ready: !!projectUri, readTask, onOpen: setTaskEditorTask })
  useEffect(() => {
    if (!pendingTaskEdit) return
    useConversationsStore.getState().setPendingTaskEdit(null)
    requestCard(pendingTaskEdit.slug)
  }, [pendingTaskEdit, requestCard])

  // LAUNCH from a card link goes STRAIGHT to the run dialog -- the editor is not
  // a waypoint. Its own resolver, because a card being read to launch and a card
  // being read to edit are two reads that must not cancel each other.
  const pendingCardLaunch = useConversationsStore(s => s.pendingCardLaunch)
  const requestLaunch = useCardResolver({ ready: !!projectUri, readTask, onOpen: setRunTaskFromEditor })
  useEffect(() => {
    if (!pendingCardLaunch) return
    useConversationsStore.getState().setPendingCardLaunch(null)
    requestLaunch(pendingCardLaunch.slug)
  }, [pendingCardLaunch, requestLaunch])

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
