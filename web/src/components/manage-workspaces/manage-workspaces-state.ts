/**
 * Opener for the Manage Workspaces surface.
 *
 * A parkable managed modal (ModalSurface), global scope -- it edits the
 * workspace axis itself, which belongs to no single project or conversation.
 * Kept in its own tiny module so the tab strip, the context menus and the
 * command palette can pop it open without importing the (lazy) modal chunk.
 */

import { useModalManagerStore } from '@/hooks/use-modal-manager'

export const MANAGE_WORKSPACES_MODAL = { id: 'manage-workspaces', kind: 'workspaces', title: 'Workspaces' }

export function openManageWorkspaces(): void {
  useModalManagerStore.getState().open(MANAGE_WORKSPACES_MODAL, { type: 'global' })
}

/** True while the surface is live in any presentation -- the lazy-mount gate. */
export function useManageWorkspacesOpen(): boolean {
  return useModalManagerStore(s => !!s.records[MANAGE_WORKSPACES_MODAL.id])
}
