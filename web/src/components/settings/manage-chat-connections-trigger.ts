import { createLazyBus } from '@/lib/lazy-bus'

/** Buffering open bus for the lazy-mounted ManageChatConnectionsDialog. The
 *  component registers via setHandler on mount; a pre-mount open is buffered +
 *  replayed, and `useArmed` drives the lazy gate. (No payload -- open()-only.) */
export const manageChatConnectionsBus = createLazyBus<void>()

export function openManageChatConnections(): void {
  manageChatConnectionsBus.open(undefined)
}
