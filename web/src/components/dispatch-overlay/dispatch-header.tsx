import { Maximize2, Minimize2, Minus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

interface DispatchHeaderProps {
  maximized: boolean
  onToggleMax: () => void
  onMinimize: () => void
}

/** Maximize-toggle + park-to-dock. Close itself is the Radix X on the dialog. */
function WindowControls({ maximized, onToggleMax, onMinimize }: DispatchHeaderProps) {
  return (
    <div className="flex flex-none items-center gap-0.5 text-comment">
      <button
        type="button"
        onClick={onToggleMax}
        title={maximized ? 'Restore' : 'Maximize'}
        aria-label={maximized ? 'Restore dispatch' : 'Maximize dispatch'}
        className="rounded-md p-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        {maximized ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
      </button>
      <button
        type="button"
        onClick={onMinimize}
        title="Minimize to dock"
        aria-label="Minimize dispatch to dock"
        // mr-6 keeps clear of the dialog's absolute close (X) button.
        className="mr-6 rounded-md p-1 hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        <Minus className="size-4" />
      </button>
    </div>
  )
}

/** Minimal desk header: identity + a verbose-state toggle + window controls
 *  (maximize / park-to-dock). Close is the Radix X on the dialog. No stats, no
 *  fleet -- the concierge doesn't greet you with a dashboard. */
export function DispatchHeader({ maximized, onToggleMax, onMinimize }: DispatchHeaderProps) {
  const verbose = useDispatchStore(s => s.verbose)
  const toggleVerbose = useDispatchStore(s => s.toggleVerbose)

  return (
    <header className="flex flex-none items-center gap-2 px-6 pt-5 pb-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />
      <span className="text-[13px] font-semibold tracking-[0.18em] text-foreground">DISPATCH</span>
      <span className="text-[11px] text-comment">your desk</span>
      <button
        type="button"
        onClick={toggleVerbose}
        aria-pressed={verbose}
        aria-label="Toggle verbose state view"
        className={cn(
          'ml-auto flex-none rounded-md px-2 py-1 font-mono text-[11px] focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring',
          verbose ? 'text-foreground' : 'text-comment hover:text-foreground',
        )}
        style={verbose ? { color: 'var(--accent)' } : undefined}
      >
        state
      </button>
      <WindowControls maximized={maximized} onToggleMax={onToggleMax} onMinimize={onMinimize} />
    </header>
  )
}
