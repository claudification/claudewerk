/**
 * The KANBAN modal -- one parkable, maximizable, detachable, project-scoped
 * surface wrapping the project task board. Opened from the project summary
 * page, the conversation header context menu, the old "Project" tab launcher,
 * and the project sidebar menu via openKanbanModal(projectUri).
 *
 * The board itself is project-keyed; a representative conversation id is
 * resolved for its "Work on this" / "Launch" actions (pickKanbanConversationId).
 */

import { KanbanSquare } from 'lucide-react'
import { KANBAN_MODAL, kanbanScopeUri, useKanbanConversationId } from '@/hooks/use-kanban-modal'
import { useManagedModal } from '@/hooks/use-modal-manager'
import { extractProjectLabel } from '@/lib/types'
import { ModalSurface } from '../modal-surface'
import { ProjectBoard } from '../project-board'

function EmptyState() {
  return (
    <div className="flex-1 min-h-0 flex items-center justify-center text-xs font-mono text-muted-foreground/50 p-8 text-center">
      No conversation is loaded for this project yet -- open or launch one to use its board.
    </div>
  )
}

export function KanbanModal() {
  const modal = useManagedModal(KANBAN_MODAL)
  const projectUri = kanbanScopeUri(modal.scope)
  // Reactive: re-resolves the target conversation as the fleet / selection changes.
  const conversationId = useKanbanConversationId(projectUri)

  if (!projectUri) return null

  return (
    <ModalSurface
      modal={modal}
      title="Kanban"
      icon={<KanbanSquare className="size-4 text-accent" />}
      headerExtra={
        <span className="text-[10px] text-muted-foreground truncate">{extractProjectLabel(projectUri)}</span>
      }
      className="max-w-6xl w-[92vw] top-[7vh] translate-y-0 h-[86vh]"
    >
      {conversationId ? (
        <div className="flex-1 min-h-0">
          <ProjectBoard conversationId={conversationId} />
        </div>
      ) : (
        <EmptyState />
      )}
    </ModalSurface>
  )
}
