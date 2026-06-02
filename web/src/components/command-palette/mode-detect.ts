import type { PaletteMode } from './types'

/**
 * Pure mode derivation from the raw filter string.
 *
 * Prefixes:
 *   `>`     command mode
 *   `s:`    spawn mode
 *   `@`     task mode (VSCode-style)
 *   `t:`    task mode (legacy)
 *   none    conversation mode (conversations + commands merged)
 *
 * Modes are mutually exclusive and resolved in priority order: command > spawn >
 * task > conversation. The boolean flags exposed alongside `mode` are
 * convenience accessors for downstream hooks that branch on a single mode.
 */
export interface PaletteModeFlags {
  mode: PaletteMode
  isCommandMode: boolean
  isSpawnMode: boolean
  isTaskMode: boolean
  isThemeMode: boolean
  isConversationMode: boolean
}

export function derivePaletteMode(filter: string): PaletteModeFlags {
  const lower = filter.toLowerCase()
  const isCommandMode = filter.startsWith('>')
  const isThemeMode = !isCommandMode && lower.startsWith('theme:')
  const isSpawnMode = !isCommandMode && !isThemeMode && lower.startsWith('s:')
  const isTaskMode = !isCommandMode && !isThemeMode && (filter.startsWith('@') || lower.startsWith('t:'))
  const isConversationMode = !isSpawnMode && !isCommandMode && !isTaskMode && !isThemeMode

  const mode: PaletteMode = isCommandMode
    ? 'command'
    : isThemeMode
      ? 'theme'
      : isSpawnMode
        ? 'spawn'
        : isTaskMode
          ? 'task'
          : 'conversation'

  return { mode, isCommandMode, isSpawnMode, isTaskMode, isThemeMode, isConversationMode }
}
