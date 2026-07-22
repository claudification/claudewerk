import { useMemo } from 'react'
import { formatShortcut, getCommandGeneration, getCommands } from '@/lib/commands'

export interface RegisteredShortcut {
  action: string
  keys: string[]
}

/**
 * Live, registry-derived list of global shortcuts, deduped by label so chord
 * aliases (⌘K X + ⌘G X) collapse into one row with two kbds. Shared by the
 * Shift+? overlay and the settings dialog's Shortcuts section -- never a
 * hardcoded list (those go stale).
 */
export function useRegisteredShortcuts(): RegisteredShortcut[] {
  const gen = getCommandGeneration()
  // biome-ignore lint/correctness/useExhaustiveDependencies: gen is a generation counter dep key that invalidates the memoized list when the registry changes
  return useMemo(() => {
    const byLabel = new Map<string, string[]>()
    for (const c of getCommands()) {
      if (!c.shortcut) continue
      const keys = formatShortcut(c.shortcut)
      const existing = byLabel.get(c.label)
      if (existing) existing.push(keys)
      else byLabel.set(c.label, [keys])
    }
    return Array.from(byLabel.entries()).map(([action, keys]) => ({ action, keys }))
    // react-doctor-disable-next-line react-doctor/exhaustive-deps
  }, [gen])
}
