/**
 * Shift+? keyboard shortcut help overlay
 * Shows all available shortcuts in a demoscene-aesthetic modal
 */

import { useState } from 'react'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { useRegisteredShortcuts } from '@/hooks/use-registered-shortcuts'
import { useCommand } from '@/lib/commands'

const INPUT_SHORTCUTS = [
  { keys: 'Enter', action: 'Send message' },
  { keys: 'Shift+Enter', action: 'New line' },
  { keys: 'Ctrl+V / Paste', action: 'Paste text or images' },
  { keys: 'Drag+Drop', action: 'Attach files' },
]

export function ShortcutHelp() {
  const [open, setOpen] = useState(false)

  useCommand('shortcut-help', () => setOpen(v => !v), {
    label: 'Keyboard shortcuts',
    shortcut: 'shift+?',
    group: 'Help',
  })

  const shortcuts = useRegisteredShortcuts()

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-w-md">
        <div className="font-mono p-6">
          <DialogTitle className="sr-only">Keyboard Shortcuts</DialogTitle>
          <pre className="text-primary text-[10px] leading-tight mb-4 select-none">
            {`┌──────────────────────────────────────┐
│  ██╗  ██╗███████╗██╗   ██╗███████╗  │
│  ██║ ██╔╝██╔════╝╚██╗ ██╔╝██╔════╝  │
│  █████╔╝ █████╗   ╚████╔╝ ███████╗  │
│  ██╔═██╗ ██╔══╝    ╚██╔╝  ╚════██║  │
│  ██║  ██╗███████╗   ██║   ███████║  │
│  ╚═╝  ╚═╝╚══════╝   ╚═╝   ╚══════╝  │
└──────────────────────────────────────┘`}
          </pre>

          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Global</div>
            {shortcuts.map(s => (
              <div key={s.action} className="flex items-center justify-between py-1 border-b border-primary/12 gap-2">
                <span className="flex items-center gap-1 flex-wrap shrink-0">
                  {s.keys.map(k => (
                    <kbd key={k} className="px-1.5 py-0.5 bg-primary/15 text-primary text-[11px]">
                      {k}
                    </kbd>
                  ))}
                </span>
                <span className="text-[11px] text-foreground truncate">{s.action}</span>
              </div>
            ))}
          </div>

          <div className="mb-4">
            <div className="text-[10px] uppercase tracking-wider text-comment mb-2">Input Bar</div>
            {INPUT_SHORTCUTS.map(s => (
              <div key={s.keys} className="flex items-center justify-between py-1 border-b border-primary/12">
                <kbd className="px-1.5 py-0.5 bg-primary/15 text-primary text-[11px]">{s.keys}</kbd>
                <span className="text-[11px] text-foreground">{s.action}</span>
              </div>
            ))}
          </div>

          <div className="text-center text-[10px] text-comment">
            Press <kbd className="px-1 py-0.5 bg-primary/12 text-primary">Esc</kbd> or{' '}
            <kbd className="px-1 py-0.5 bg-primary/12 text-primary">Shift+?</kbd> to close
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
