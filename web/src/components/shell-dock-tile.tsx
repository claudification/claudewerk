/**
 * ShellDockTile -- one host shell in the unified <Dock>'s shells section.
 *
 * Shells are always-present roster entries (not minimized-vs-open): a tile with
 * an activity light that blinks on output; clicking EXPANDS it (subscribe +
 * ShellOverlay). Split out of the dock so the tray composition stays small.
 */
import { ExternalLink, SquareTerminal, X } from 'lucide-react'
import { useEffect, useState } from 'react'
import { useIsShellSubscribed, useShellActivityTs, useShellRoster } from '@/hooks/use-shells'
import { closeShell, popoutShell, shellLightClass, shellTitle } from '@/lib/shell-commands'
import { cn } from '@/lib/utils'

/** Blinking activity light. Flashes for ~600ms whenever the shell emits output
 *  (its `activity` ts advances). Dimmed while expanded (you're already watching);
 *  amber + animated while minimized (unread). */
function ShellActivityLight({ shellId }: { shellId: string }) {
  const ts = useShellActivityTs(shellId)
  const subscribed = useIsShellSubscribed(shellId)
  const [flash, setFlash] = useState(false)

  // Inline render-time adjustment: flash on immediately when ts changes (no stale
  // unlit frame). The timeout to clear the flash stays in the effect.
  const [prevTs, setPrevTs] = useState(ts)
  if (ts !== undefined && ts !== prevTs) {
    setPrevTs(ts)
    setFlash(true)
  }

  useEffect(() => {
    if (!flash) return
    const t = setTimeout(() => setFlash(false), 600)
    return () => clearTimeout(t)
  }, [flash])

  return (
    <span
      className={cn(
        'inline-block size-1.5 rounded-full transition-colors',
        shellLightClass(flash, subscribed, ts !== undefined),
        flash && 'animate-pulse',
      )}
    />
  )
}

export function ShellDockTile({ shellId, onExpand }: { shellId: string; onExpand: () => void }) {
  const roster = useShellRoster()
  const entry = roster[shellId]
  const subscribed = useIsShellSubscribed(shellId)
  if (!entry) return null

  return (
    <div
      className={cn(
        'group flex items-center gap-1.5 rounded border px-2 py-1 text-[11px] font-mono transition-colors',
        subscribed
          ? 'border-emerald-500/40 bg-emerald-500/10 text-emerald-200'
          : 'border-white/10 bg-white/5 text-white/70 hover:bg-white/10 hover:text-white',
      )}
    >
      <ShellActivityLight shellId={shellId} />
      <button
        type="button"
        onClick={onExpand}
        className="flex items-center gap-1.5 max-w-[160px]"
        title={`${shellTitle(entry)} — ${entry.path}`}
      >
        <SquareTerminal className="size-3 shrink-0 opacity-70" />
        <span className="truncate">{shellTitle(entry)}</span>
      </button>
      <button
        type="button"
        onClick={() => popoutShell(shellId)}
        className="shrink-0 text-white/30 hover:text-white transition-colors opacity-0 group-hover:opacity-100"
        title="Detach to its own window"
      >
        <ExternalLink className="size-3" />
      </button>
      <button
        type="button"
        onClick={() => closeShell(shellId)}
        className="shrink-0 text-white/30 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
        title="Kill shell"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}
