import type { PaletteMode } from './types'

/**
 * Pure mode derivation from the raw filter string.
 *
 * Prefixes:
 *   `>`     command mode
 *   `f:`    file mode (but `f:/` is treated as a literal filter, not file mode)
 *   `s:`    spawn mode
 *   `@`     task mode (VSCode-style)
 *   `t:`    task mode (legacy)
 *   none    session mode (sessions + commands merged)
 *
 * Modes are mutually exclusive and resolved in priority order: command > file
 * > spawn > task > session. The boolean flags exposed alongside `mode` are
 * convenience accessors for downstream hooks that branch on a single mode.
 */
export interface PaletteModeFlags {
  mode: PaletteMode
  isCommandMode: boolean
  isFileMode: boolean
  isSpawnMode: boolean
  isTaskMode: boolean
  isConversationMode: boolean
}

export function derivePaletteMode(filter: string): PaletteModeFlags {
  const isCommandMode = filter.startsWith('>')
  const isFileMode = !isCommandMode && filter.toLowerCase().startsWith('f:') && !filter.toLowerCase().startsWith('f:/')
  const isSpawnMode = !isCommandMode && filter.toLowerCase().startsWith('s:')
  const isTaskMode = !isCommandMode && (filter.startsWith('@') || filter.toLowerCase().startsWith('t:'))
  const isConversationMode = !isFileMode && !isSpawnMode && !isCommandMode && !isTaskMode

  const mode: PaletteMode = isCommandMode
    ? 'command'
    : isSpawnMode
      ? 'spawn'
      : isFileMode
        ? 'file'
        : isTaskMode
          ? 'task'
          : 'session'

  return { mode, isCommandMode, isFileMode, isSpawnMode, isTaskMode, isConversationMode }
}
