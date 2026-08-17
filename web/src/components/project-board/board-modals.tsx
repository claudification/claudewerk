/**
 * The card editor and the run dialog, and the wiring between them.
 *
 * Both are driven entirely by `useCardActions`, so keeping their JSX in the
 * board orchestrator meant every inline callback here counted against that
 * component's complexity for no benefit. Nothing in this file knows about
 * lanes, grouping or filters.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { enqueueNightshiftTask } from '@/hooks/use-nightshift-queue'
import type { ProjectTask, TaskStatus } from '@/hooks/use-project'
import { haptic } from '@/lib/utils'
import { RunTaskDialog } from './run-task-dialog'
import { TaskEditor } from './task-editor'

/** The card patch shape `TaskEditor` saves with. */
export type TaskPatch = { title?: string; body?: string; priority?: string; tags?: string[] }

export interface BoardModalsProps {
  conversationId: string
  editingTask: ProjectTask | null
  setEditingTask: React.Dispatch<React.SetStateAction<ProjectTask | null>>
  runTask: ProjectTask | null
  setRunTask: (task: ProjectTask | null) => void
  moveTask: (id: string, to: TaskStatus) => Promise<string | false>
  updateTask: (id: string, patch: TaskPatch) => Promise<unknown>
}

export function BoardModals({
  conversationId,
  editingTask,
  setEditingTask,
  runTask,
  setRunTask,
  moveTask,
  updateTask,
}: BoardModalsProps) {
  function promote(task: ProjectTask) {
    const uri = useConversationsStore.getState().conversationsById[conversationId]?.project
    if (!uri) return
    void enqueueNightshiftTask(uri, {
      title: task.title,
      description: task.body || undefined,
      source: 'board',
      boardRef: task.slug,
    })
    setEditingTask(null)
    haptic('success')
  }

  async function move(id: string, to: TaskStatus) {
    const result = await moveTask(id, to)
    // The card's id and path are unchanged -- only its lane moved, so the open
    // editor just needs its status refreshed.
    if (result) setEditingTask(prev => (prev && prev.slug === id ? { ...prev, status: to } : prev))
    return !!result
  }

  return (
    <>
      {editingTask && (
        <TaskEditor
          task={editingTask}
          conversationId={conversationId}
          onSave={updateTask}
          onMove={move}
          onRun={task => {
            setEditingTask(null)
            setRunTask(task)
          }}
          onPromote={promote}
          // The epic strip navigates by swapping the open editor's card, so
          // walking child -> epic never costs you the dialog.
          onOpenTask={setEditingTask}
          onClose={() => setEditingTask(null)}
        />
      )}

      {/* Lifted out of TaskEditor so it persists after the editor closes. */}
      {runTask && <RunTaskDialog task={runTask} conversationId={conversationId} onClose={() => setRunTask(null)} />}
    </>
  )
}
