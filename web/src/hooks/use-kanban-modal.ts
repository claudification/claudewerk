/**
 * Kanban modal opener. The Kanban board is a single parkable, detachable,
 * project-scoped managed modal (built on ModalSurface). Every entry point
 * (project summary page, conversation header context menu, the old "Project"
 * tab launcher, project sidebar menu) calls `openKanbanModal(projectUri)`.
 *
 * The board itself is project-keyed for data, but a few actions ("Work on
 * this", "Launch") target a live conversation -- `pickKanbanConversationId`
 * picks a representative one for the project (the selected conversation if it
 * belongs here, else the fleet's best conversation for that project).
 */

import { selectConversations } from '@/lib/slim-conversation'
import type { Conversation } from '@/lib/types'
import type { ModalScope } from './modal-manager-types'
import { findBestConversationForProject, useConversationsStore } from './use-conversations'
import { useModalManagerStore } from './use-modal-manager'

export const KANBAN_MODAL = { id: 'kanban', kind: 'kanban', title: 'Kanban' }

/** The project uri a Kanban modal is scoped to, or undefined (closed / other). */
export function kanbanScopeUri(scope: ModalScope | undefined): string | undefined {
  return scope?.type === 'project' ? scope.uri : undefined
}

/** Pick a representative conversation id for the project's board actions. Pure
 *  over the store slice so it can drive a reactive Zustand selector. */
function pickKanbanConversationId(
  state: { selectedConversationId: string | null; conversationsById: Record<string, Conversation> },
  projectUri: string,
): string | null {
  const sel = state.selectedConversationId
  if (sel && state.conversationsById[sel]?.project === projectUri) return sel
  return findBestConversationForProject(selectConversations(state.conversationsById), projectUri)?.id ?? null
}

/** Reactive target conversation for a project's board (null when unscoped). */
export function useKanbanConversationId(projectUri: string | undefined): string | null {
  return useConversationsStore(s => (projectUri ? pickKanbanConversationId(s, projectUri) : null))
}

/** Open (or re-focus) the Kanban board for a project. */
export function openKanbanModal(projectUri: string): void {
  useModalManagerStore.getState().open(KANBAN_MODAL, { type: 'project', uri: projectUri })
}
