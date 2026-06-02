import { createLazyBus } from '@/lib/lazy-bus'

export interface ReviveDialogOptions {
  conversationId: string
}

/** Buffering open bus so any component can pop the (lazy-mounted) revive dialog.
 *  ReviveDialog registers its handler on mount via setHandler; a pre-mount open
 *  is buffered and replayed, and `useArmed` drives the lazy gate. */
export const reviveDialogBus = createLazyBus<ReviveDialogOptions>()

/** Open the revive dialog from anywhere */
export function openReviveDialog(options: ReviveDialogOptions): void {
  reviveDialogBus.open(options)
}
