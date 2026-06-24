/**
 * A minimized live dialog (THE DIALOGUE) surfaced in the global ModalDock.
 *
 * Restore WARPS to the owning conversation, then expands the dialog in place
 * (the same `setCollapsed(false)` the inline bar uses). Close maps to the
 * authoritative dismiss — same as the inline CollapsedDialogBar's x — dropping
 * the broker slot for everyone. Purely additive: no change to THE DIALOGUE core.
 */
import { useConversationsStore } from '@/hooks/use-conversations'
import { useLiveDialogsStore } from '@/hooks/use-live-dialogs'
import { DockTile } from '../dock-tile'

export function LiveDialogDockTile({ conversationId, title }: { conversationId: string; title: string }) {
  const owner = useConversationsStore(s => s.conversationsById[conversationId]?.title) || conversationId.slice(0, 8)
  const setCollapsed = useLiveDialogsStore(s => s.setCollapsed)
  const dismiss = useLiveDialogsStore(s => s.dismiss)

  return (
    <DockTile
      title={title}
      owner={owner}
      closeTitle="Dismiss dialog"
      onRestore={() => {
        useConversationsStore.getState().selectConversation(conversationId, 'live-dialog-restore')
        setCollapsed(conversationId, false)
      }}
      onClose={() => dismiss(conversationId)}
    />
  )
}
