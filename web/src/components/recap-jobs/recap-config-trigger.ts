import { createLazyBus } from '@/lib/lazy-bus'

export interface RecapConfigOptions {
  /** Project URI to recap, or '*' for all projects. */
  projectUri: string
}

/** Buffering open bus so any surface (context menus, command palette) can open
 *  the lazy-mounted recap config modal without importing the component.
 *  RecapConfigDialog registers via setHandler on mount; a pre-mount open is
 *  buffered + replayed, and `useArmed` drives the lazy gate. */
export const recapConfigBus = createLazyBus<RecapConfigOptions>()

export function openRecapConfigDialog(options: RecapConfigOptions): void {
  recapConfigBus.open(options)
}
