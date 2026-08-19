/**
 * The banners + overlays that sit above the conversation pane: clipboard
 * capture, the share banner, the live-dialog surface, and the task editor.
 *
 * Split out of conversation-detail.tsx (over the .tsx line bar) -- none of it
 * shares state with the header/tabs/transcript below, and pulling useTaskEditor
 * down here removes eight props of drilling with it.
 */

import { useConversationsStore } from '@/hooks/use-conversations'
import { lazyModule, named } from '@/lib/lazy-module'
import { ShareBanner } from '../share-panel'
import { ClipboardBanners } from './conversation-banners'
import { DialogOverlay } from './conversation-input'
import { TaskEditorOverlay } from './task-editor-overlay'
import { useTaskEditor } from './use-task-editor'

// RUN drags the whole epic-run dialog (briefing, plan, settings) behind it, and
// it is raised from ONE menu item on a card link. It stays out of the transcript
// chunk until someone picks that item.
const EpicRunOverlay = lazyModule(
  named(() => import('./epic-run-overlay'), 'EpicRunOverlay'),
  () => useConversationsStore(s => s.pendingEpicRun !== null),
)

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

      <EpicRunOverlay conversationId={conversationId} />
    </>
  )
}
