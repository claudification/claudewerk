export interface SpawnDialogOptions {
  path: string
  mkdir?: boolean
  sentinel?: string
  /** Source project URI -- when scheme is `opencode://`, the dialog defaults
   *  the backend selector to OpenCode instead of Claude. */
  projectUri?: string
  /** Launch profile to pre-apply on open. The dropdown reflects this selection. */
  profileId?: string
  /** Sentinel-profile NAME or selection-mode token (`default` | `balanced` |
   *  `random`). Parsed from the `@sentinel:profile` shorthand or a
   *  `claude://profile@sentinel/...` URI. Pre-selects the Sentinel-profile
   *  radio in the launch modal. */
  profile?: string
  /** Sentinel-pool name (e.g. `"work"`). Parsed from the `@sentinel#pool`
   *  shorthand. Pre-selects Balanced + pool in the launch modal when present
   *  without an explicit `profile`. Mutually exclusive with Fixed profile. */
  pool?: string
}

/** Module-level bus for the SpawnDialog. The dialog registers its handler
 *  on mount and clears it on unmount; openers route through this bus. */
export const _spawnDialogBus: {
  open: ((options: SpawnDialogOptions) => void) | null
} = { open: null }

/** Open the spawn dialog from anywhere */
export function openSpawnDialog(options: SpawnDialogOptions): void {
  _spawnDialogBus.open?.(options)
}
