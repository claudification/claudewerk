/**
 * Read-only shortcut reference in the settings dialog (Input tab). Derived
 * live from the command registry -- the old hardcoded list shipped a wrong
 * palette binding (Ctrl+K; the real one is Cmd+P) for months.
 */

import { Kbd } from '@/components/ui/kbd'
import { useRegisteredShortcuts } from '@/hooks/use-registered-shortcuts'
import { formatShortcut, getCommands } from '@/lib/commands'
import { GroupHeader } from './settings-inputs'

const SECTION_TERMS = 'shortcuts keyboard keys hotkey'

export function shortcutsSectionMatches(filter: string): boolean {
  return (
    SECTION_TERMS.includes(filter) ||
    getCommands().some(
      c =>
        c.shortcut &&
        (c.label.toLowerCase().includes(filter) || formatShortcut(c.shortcut).toLowerCase().includes(filter)),
    )
  )
}

export function ShortcutsSection({ filter }: { filter: string }) {
  const shortcuts = useRegisteredShortcuts()
  const rowMatchesSection = SECTION_TERMS.includes(filter)
  const visible = filter
    ? shortcuts.filter(
        s =>
          rowMatchesSection ||
          s.action.toLowerCase().includes(filter) ||
          s.keys.some(k => k.toLowerCase().includes(filter)),
      )
    : shortcuts
  return (
    <div>
      <GroupHeader label="Shortcuts" />
      <div className="space-y-1.5">
        {visible.map(s => (
          <div key={s.action} className="flex items-center justify-between gap-2 text-xs">
            <span className="text-muted-foreground truncate">{s.action}</span>
            <span className="flex gap-1 shrink-0">
              {s.keys.map(k => (
                <Kbd key={k} className="font-mono text-[10px] border border-border rounded-none">
                  {k}
                </Kbd>
              ))}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
