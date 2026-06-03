/**
 * ShellOverlay -- the expanded (subscribed) view of one host shell.
 *
 * Fullscreen panel hosting a ShellPane plus minimal chrome: title + path,
 * minimize (unsubscribe, keep the tile), detach (popout window), close (kill
 * the PTY). Mirrors WebTerminal's overlay treatment but for the `shell_*`
 * transport. Mounting subscribes; unmounting (minimize / close) unsubscribes.
 */
import { ExternalLink, Minus, X } from 'lucide-react'
import { useEffect } from 'react'
import { useShellEntry } from '@/hooks/use-shells'
import { closeShell, shellDisplayPath, shellTitle } from '@/lib/shell-commands'
import { useScrollLock } from './input-editor/shell/use-scroll-lock'
import { ShellPane } from './shell-pane'

interface ShellOverlayProps {
  shellId: string
  /** Minimize: drop the byte stream, keep the roster tile + light. */
  onMinimize: () => void
}

export function ShellOverlay({ shellId, onMinimize }: ShellOverlayProps) {
  const entry = useShellEntry(shellId)
  useScrollLock(true)

  // Esc minimizes (cheap, reversible). Kill is explicit via the X button.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault()
        onMinimize()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onMinimize])

  const title = entry ? shellTitle(entry) : shellId.slice(0, 8)
  const path = entry ? shellDisplayPath(entry) : ''

  function detach() {
    window.open(`/#popout-shell/${shellId}`, '_blank', 'width=900,height=600,menubar=no,toolbar=no')
    onMinimize()
  }

  return (
    <div
      data-shell-overlay
      role="application"
      className="fixed inset-0 z-50 flex flex-col bg-[#0a0a0a] overflow-hidden"
      style={{ overscrollBehavior: 'none' }}
    >
      <div className="shrink-0 flex items-center gap-2 border-b border-white/10 bg-black/60 px-3 py-1.5">
        <span className="text-[11px] font-mono font-semibold text-emerald-300">{title}</span>
        <span className="text-[10px] font-mono text-white/40 truncate flex-1">{path}</span>
        <span className="text-[9px] font-mono text-white/30 hidden sm:inline mr-1">esc minimize</span>
        <button
          type="button"
          onClick={onMinimize}
          className="p-1 text-white/50 hover:text-white transition-colors"
          title="Minimize (keep running)"
        >
          <Minus className="size-4" />
        </button>
        <button
          type="button"
          onClick={detach}
          className="p-1 text-white/50 hover:text-white transition-colors"
          title="Detach to its own window"
        >
          <ExternalLink className="size-3.5" />
        </button>
        <button
          type="button"
          onClick={() => closeShell(shellId)}
          className="p-1 text-white/50 hover:text-red-400 transition-colors"
          title="Kill shell"
        >
          <X className="size-4" />
        </button>
      </div>

      <div className="relative flex-1 min-h-0 overflow-hidden" style={{ overscrollBehavior: 'contain' }}>
        <ShellPane shellId={shellId} className="absolute inset-0 p-1" />
      </div>
    </div>
  )
}
