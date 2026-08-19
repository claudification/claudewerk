import { createLazyBus } from '@/lib/lazy-bus'
import type { ForkPointSeed } from './fork-dialog/fork-point'

export interface ForkDialogOptions {
  /** The conversation being forked FROM. */
  conversationId: string
  /**
   * The transcript entry the fork was started from, when it was started from
   * one. Absent = fork from HEAD, the original behaviour.
   */
  forkPoint?: ForkPointSeed
}

/** Buffering open bus for the (lazy-mounted) fork dialog -- same contract as
 *  the revive bus: ForkDialog registers its handler on mount, a pre-mount open
 *  is buffered and replayed, and `useArmed` drives the lazy gate. */
export const forkDialogBus = createLazyBus<ForkDialogOptions>()

/** Open the fork dialog from anywhere. */
export function openForkDialog(options: ForkDialogOptions): void {
  forkDialogBus.open(options)
}
