/**
 * The banners + overlays that sit above the conversation pane: clipboard
 * capture, the share banner, the live-dialog surface, and the task editor.
 *
 * Split out of conversation-detail.tsx (over the .tsx line bar) -- none of it
 * shares state with the header/tabs/transcript below, and pulling useTaskEditor
 * down here removes eight props of drilling with it.
 */

import { ShareBanner } from '../share-panel'
import { ClipboardBanners } from './conversation-banners'
import { DialogOverlay } from './conversation-input'
import { TaskEditorOverlay } from './task-editor-overlay'
import { useTaskEditor } from './use-task-editor'

interface DetailOverlaysProps {
  conversationId: string
  conversationProject: string
  canAdmin: boolean
}

export function DetailOverlays({ conversationId, conversationProject, canAdmin }: DetailOverlaysProps) {
  const { taskEditorTask, runTaskFromEditor, updateTask, moveTask, setRunTaskFromEditor, setTaskEditorTask } =
    useTaskEditor(conversationId)

  return (
    <>
      <ClipboardBanners conversationId={conversationId} />
      {canAdmin && <ShareBanner conversationProject={conversationProject} conversationId={conversationId} />}
      <DialogOverlay conversationId={conversationId} />

      <TaskEditorOverlay
        conversationId={conversationId}
        taskEditorTask={taskEditorTask}
        runTaskFromEditor={runTaskFromEditor}
        onUpdateTask={updateTask}
        onMoveTask={moveTask}
        onRunTask={setRunTaskFromEditor}
        onCloseEditor={() => setTaskEditorTask(null)}
        onCloseRunDialog={() => setRunTaskFromEditor(null)}
        onSetTaskEditorTask={setTaskEditorTask}
      />
    </>
  )
}
