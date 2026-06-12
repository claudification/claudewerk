import { useRenameModal } from '@/hooks/use-rename-modal'
import { RenameDialogBody } from './rename-dialog-body'
import { Dialog } from './ui/dialog'

export function RenameModal() {
  const state = useRenameModal()

  if (!state.selectedConversationId) return null

  return (
    <Dialog open={state.open} onOpenChange={state.handleOpenChange}>
      <RenameDialogBody state={state} />
    </Dialog>
  )
}
