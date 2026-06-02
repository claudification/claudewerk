import { createLazyBus } from '@/lib/lazy-bus'

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

/** Buffering open bus for the SpawnDialog. The dialog is lazy-mounted, so an
 *  `openSpawnDialog` call may arrive before its body exists -- the bus buffers
 *  it, arms the lazy gate (`spawnDialogBus.useArmed`), and replays it once the
 *  dialog registers its handler on mount. */
export const spawnDialogBus = createLazyBus<SpawnDialogOptions>()

/** Open the spawn dialog from anywhere */
export function openSpawnDialog(options: SpawnDialogOptions): void {
  spawnDialogBus.open(options)
}
