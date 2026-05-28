/** Module-level bus for the ManageChatConnectionsDialog. The component
 *  registers its handler on mount; openers route through this bus so the
 *  component file stays Fast-Refresh clean. */
export const _manageChatConnectionsBus: { open: (() => void) | null } = { open: null }

export function openManageChatConnections(): void {
  _manageChatConnectionsBus.open?.()
}
