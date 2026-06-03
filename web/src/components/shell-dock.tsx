/**
 * ShellDock -- the global, permission-filtered top-bar tray of host shells.
 *
 * Shells are to the top bar what conversations are to the sidebar: a roster of
 * floating instances, each a minimized tile with an activity light that blinks
 * on output. Clicking a tile EXPANDS it (subscribe + ShellOverlay); the byte
 * stream only flows while expanded. Driven entirely by the global roster --
 * independent of any selected conversation.
 *
 * Self-hides when the roster is empty.
 */
import { SquareTerminal, X } from 'lucide-react'
import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { useIsShellSubscribed, useShellActivityTs, useShellRoster } from '@/hooks/use-shells'
import { closeShell, shellLightClass, shellTitle } from '@/lib/shell-commands'
import { cn } from '@/lib/utils'

// xterm.js is heavy -- keep it out of the index chunk; pulled on first expand.
const ShellOverlay = lazy(() => import('./shell-overlay').then(m => ({ default: m.ShellOverlay })))

/** Blinking activity light. Flashes for ~600ms whenever the shell emits output
 *  (its `activity` ts advances). Dimmed while expanded (you're already watching);
 *  amber + animated while minimized (unread). */
function ShellActivityLight({ shellId }: { shellId: string }) {
  const ts = useShellActivityTs(shellId)
  const subscribed = useIsShellSubscribed(shellId)
  const [flash, setFlash] = useState(false)
  const lastTs = useRef<number | undefined>(ts)

  useEffect(() => {
    if (ts === undefined || ts === lastTs.current) return
    lastTs.current = ts
    setFlash(true)
    const t = setTimeout(() => setFlash(false), 600)
    return () => clearTimeout(t)
  }, [ts])

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

function ShellTile({ shellId, onExpand }: { shellId: string; onExpand: () => void }) {
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
        onClick={() => closeShell(shellId)}
        className="shrink-0 text-white/30 hover:text-red-400 transition-colors opacity-0 group-hover:opacity-100"
        title="Kill shell"
      >
        <X className="size-3" />
      </button>
    </div>
  )
}

export function ShellDock() {
  const roster = useShellRoster()
  const [expandedId, setExpandedId] = useState<string | null>(null)

  // Newest first -- the freshest shell is the most likely target.
  const shellIds = useMemo(
    () =>
      Object.values(roster)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map(s => s.shellId),
    [roster],
  )

  // Drop the expanded selection if that shell left the roster (killed/exited).
  useEffect(() => {
    if (expandedId && !roster[expandedId]) setExpandedId(null)
  }, [expandedId, roster])

  if (shellIds.length === 0) return null

  return (
    <>
      <div className="flex items-center gap-1.5 overflow-x-auto py-1" data-shell-dock>
        <span className="text-[9px] font-mono uppercase tracking-wide text-white/30 shrink-0 px-1">shells</span>
        {shellIds.map(shellId => (
          <ShellTile key={shellId} shellId={shellId} onExpand={() => setExpandedId(shellId)} />
        ))}
      </div>
      {expandedId && roster[expandedId] && (
        <Suspense fallback={null}>
          <ShellOverlay shellId={expandedId} onMinimize={() => setExpandedId(null)} />
        </Suspense>
      )}
    </>
  )
}
