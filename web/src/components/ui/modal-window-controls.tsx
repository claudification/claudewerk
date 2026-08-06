/**
 * Maximize / minimize controls for a managed modal's title bar.
 *
 * Every managed surface grew its own copy of these two buttons; this is the one
 * definition. `mr-6` clears the Dialog's own close button.
 */

import { Maximize2, Minimize2, Minus } from 'lucide-react'

interface Props {
  maximized: boolean
  onToggleMaximize: () => void
  onMinimize: () => void
}

export function ModalWindowControls({ maximized, onToggleMaximize, onMinimize }: Props) {
  return (
    <div className="ml-auto mr-6 flex items-center gap-1.5 text-muted-foreground">
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
