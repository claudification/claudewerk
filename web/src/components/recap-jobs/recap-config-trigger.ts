export interface RecapConfigOptions {
  /** Project URI to recap, or '*' for all projects. */
  projectUri: string
}

/** Module-level bus so any surface (context menus, command palette) can open the
 *  recap config modal without importing the component (which would mix
 *  non-component exports into a Fast-Refresh file). RecapConfigDialog registers
 *  its handler on mount and clears it on unmount. */
export const _recapConfigBus: {
  open: ((options: RecapConfigOptions) => void) | null
} = { open: null }

export function openRecapConfigDialog(options: RecapConfigOptions): void {
  _recapConfigBus.open?.(options)
}
