import { createLazyBus } from '@/lib/lazy-bus'

/** Buffering open bus for the lazy-mounted ManageProjectLinksDialog. The
 *  component registers via setHandler on mount; a pre-mount open is buffered +
 *  replayed, and `useArmed` drives the lazy gate. */
export const manageProjectLinksBus = createLazyBus<string | undefined>()

export function openManageProjectLinks(projectUri?: string): void {
  manageProjectLinksBus.open(projectUri)
}
