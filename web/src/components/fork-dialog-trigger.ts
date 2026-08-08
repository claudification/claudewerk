import { createLazyBus } from '@/lib/lazy-bus'

export interface ForkDialogOptions {
  /** The conversation being forked FROM. */
  conversationId: string
}

/** Buffering open bus for the (lazy-mounted) fork dialog -- same contract as
 *  the revive bus: ForkDialog registers its handler on mount, a pre-mount open
 *  is buffered and replayed, and `useArmed` drives the lazy gate. */
export const forkDialogBus = createLazyBus<ForkDialogOptions>()

/** Open the fork dialog from anywhere. */
export function openForkDialog(options: ForkDialogOptions): void {
  forkDialogBus.open(options)
}
