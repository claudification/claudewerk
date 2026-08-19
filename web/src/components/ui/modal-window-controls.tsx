/**
 * Maximize / minimize controls for a managed modal's title bar.
 *
 * Every managed surface grew its own copy of these two buttons; this is the one
 * definition.
 *
 * The `mr-6` that used to sit here cleared the Dialog's own close button by
 * hand. That clearance is structural now (DialogContent reserves the corner on
 * its first child), so keeping it would double the gap -- and hand-reserving it
 * was what every surface WITHOUT these controls forgot to do.
 */

import { Maximize2, Minimize2, Minus } from 'lucide-react'

interface Props {
  maximized: boolean
  onToggleMaximize: () => void
  onMinimize: () => void
}

export function ModalWindowControls({ maximized, onToggleMaximize, onMinimize }: Props) {
  return (
    <div className="ml-auto flex items-center gap-1.5 text-fg-muted">
      <button
        type="button"
        onClick={onToggleMaximize}
        title={maximized ? 'Restore' : 'Maximize'}
        className="hover:text-foreground transition-colors"
      >
        {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
      <button
        type="button"
        onClick={onMinimize}
        title="Minimize to dock"
        className="hover:text-foreground transition-colors"
      >
        <Minus className="size-4" />
      </button>
    </div>
  )
}
