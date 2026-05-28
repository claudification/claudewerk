/** Module-level bus for the TerminateConfirmDialog. The component registers
 *  its handler on mount; openers route through this bus so the dialog file
 *  stays Fast-Refresh clean. */
export const _terminateConfirmBus: {
  open: ((conversationId: string, conversationName: string | null) => void) | null
} = { open: null }

export function openTerminateConfirm(conversationId: string, conversationName: string | null): void {
  _terminateConfirmBus.open?.(conversationId, conversationName)
}
