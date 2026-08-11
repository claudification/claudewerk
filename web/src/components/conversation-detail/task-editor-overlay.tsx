import type { ProjectTask, TaskStatus } from '@/hooks/use-project'
import { RunTaskDialog, TaskEditor } from '../project-board'

interface TaskEditorOverlayProps {
  conversationId: string
  taskEditorTask: ProjectTask | null
  runTaskFromEditor: ProjectTask | null
  onUpdateTask: (
    id: string,
    patch: { title?: string; body?: string; priority?: string; tags?: string[] },
  ) => Promise<unknown>
  onMoveTask: (id: string, to: TaskStatus) => Promise<string | false>
  onRunTask: (task: ProjectTask) => void
  onCloseEditor: () => void
  onCloseRunDialog: () => void
  onSetTaskEditorTask: (task: ProjectTask | null) => void
}

export function TaskEditorOverlay({
  conversationId,
  taskEditorTask,
  runTaskFromEditor,
  onUpdateTask,
  onMoveTask,
  onRunTask,
  onCloseEditor,
  onCloseRunDialog,
  onSetTaskEditorTask,
}: TaskEditorOverlayProps) {
  return (
    <>
      {taskEditorTask && (
        <TaskEditor
          task={taskEditorTask}
          conversationId={conversationId}
          onSave={async (id, patch) => {
            await onUpdateTask(id, patch)
          }}
          onMove={async (id, to) => {
            const result = await onMoveTask(id, to)
            // Only the lane changed -- the card's id and path are untouched.
            if (result)
              onSetTaskEditorTask(taskEditorTask.slug === id ? { ...taskEditorTask, status: to } : taskEditorTask)
            return !!result
          }}
          onRun={task => {
            onCloseEditor()
            onRunTask(task)
          }}
          onClose={onCloseEditor}
        />
      )}
      {runTaskFromEditor && (
        <RunTaskDialog task={runTaskFromEditor} conversationId={conversationId} onClose={onCloseRunDialog} />
      )}
    </>
  )
}
