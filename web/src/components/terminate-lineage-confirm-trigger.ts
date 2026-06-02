/** Module-level bus for the TerminateLineageConfirmDialog. The component
 *  registers its handler on mount; openers route through this bus so the
 *  dialog file stays Fast-Refresh clean. Mirrors terminate-confirm-trigger. */
export const _terminateLineageConfirmBus: {
  open: ((conversationId: string) => void) | null
} = { open: null }

/** Open the "terminate full lineage" confirmation for the subtree rooted at
 *  `conversationId` (that conversation + all its descendants). */
export function openTerminateLineageConfirm(conversationId: string): void {
  _terminateLineageConfirmBus.open?.(conversationId)
}
