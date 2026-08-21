/**
 * The card editor and the run dialog, and the wiring between them.
 *
 * Both are driven entirely by `useCardActions`, so keeping their JSX in the
 * board orchestrator meant every inline callback here counted against that
 * component's complexity for no benefit. Nothing in this file knows about
 * lanes, grouping or filters.
 */

import { NIGHTSHIFT_TAG } from '@shared/nightshift-types'
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
  /**
   * Put the card on tonight's list by TAGGING it.
   *
   * This used to `enqueueNightshiftTask` -- copy the card's title and body into
   * `.nightshift/queue/` with a `boardRef` string pointing back. The copy went
   * stale the moment anyone edited the card, the pointer dangled the moment
   * anyone renamed it, and the board could not show you that a card was queued
   * at all. Now the card IS the item: the scanner reads `#nightshift` off the
   * board and builds the task from the card's current body at dispatch time
   * (`src/broker/scanners/nightshift-scanner.ts`).
   *
   * Idempotent, because the tag is a state and not an event -- pressing the
   * button twice cannot put a card on the list twice.
   */
  function promote(task: ProjectTask) {
    if (!task.tags.includes(NIGHTSHIFT_TAG)) {
      void updateTask(task.slug, { tags: [...task.tags, NIGHTSHIFT_TAG] })
    }
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
          // A DIFFERENT CARD IS A DIFFERENT EDITOR. The editor seeds its title
          // and body from props once, on mount, and its sync effect refreshes
          // only status/priority/tags so a background refresh cannot clobber
          // what someone is typing. Without this key, swapping the card (a
          // `.rclaude/project/**` link, a deep link, a push notification) kept
          // the OLD card's text under the NEW card's header -- and saved it
          // there.
          key={editingTask.slug}
          task={editingTask}
          conversationId={conversationId}
          onSave={updateTask}
          onMove={move}
          onRun={task => {
            setEditingTask(null)
            setRunTask(task)
          }}
          onPromote={promote}
          onClose={() => setEditingTask(null)}
        />
      )}

      {/* Lifted out of TaskEditor so it persists after the editor closes. */}
      {runTask && <RunTaskDialog task={runTask} conversationId={conversationId} onClose={() => setRunTask(null)} />}
    </>
  )
}
