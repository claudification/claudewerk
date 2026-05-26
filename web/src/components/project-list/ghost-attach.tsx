/**
 * Ghost-row affordances: the "GHOST" badge + the inline "attach" button shown on
 * a daemon worker claudewerk is mirroring read-only but not yet hosting.
 *
 * Attaching SPAWNS a daemon-host + leases the worker -- a real side effect -- so
 * it is an EXPLICIT button, never a row-click. Row-click stays select/preview.
 */

import { useState } from 'react'
import { attachGhost } from '@/hooks/use-ghost-sessions'
import { cn, haptic } from '@/lib/utils'

/** Violet "GHOST" badge -- a discovered, not-yet-attached daemon worker. */
export function GhostBadge({ compact = false }: { compact?: boolean }) {
  return (
    <span
      className={cn(
        'uppercase font-bold text-violet-300 shrink-0',
        compact ? 'text-[9px]' : 'px-1.5 py-0.5 text-[10px] bg-violet-500/20 border border-violet-500/40',
      )}
      title="Discovered daemon worker -- claudewerk mirrors it read-only. Attach to take it over interactively."
    >
      {'◌'} ghost
    </span>
  )
}

/** Inline "attach" button. Stops propagation so it never triggers row-select. */
export function GhostAttachButton({ conversationId, compact = false }: { conversationId: string; compact?: boolean }) {
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function onAttach(e: React.MouseEvent | React.KeyboardEvent) {
    e.stopPropagation()
    if (pending) return
    haptic('tap')
    setPending(true)
    setError(null)
    const result = await attachGhost(conversationId)
    setPending(false)
    if (result.ok) haptic('success')
    else {
      setError(result.error)
      haptic('error')
    }
  }

  return (
    <span
      role="button"
      tabIndex={0}
      onClick={onAttach}
      onKeyDown={e => {
        if (e.key === 'Enter' || e.key === ' ') onAttach(e)
      }}
      className={cn(
        'shrink-0 cursor-pointer font-bold uppercase border transition-colors',
        compact ? 'text-[9px] px-1 py-0.5' : 'text-[10px] px-1.5 py-0.5',
        pending
          ? 'text-violet-300/60 border-violet-500/30 cursor-wait'
          : 'text-violet-300 border-violet-500/40 hover:bg-violet-500/20 hover:text-violet-200',
      )}
      title={error ? `Attach failed: ${error}` : 'Attach to this daemon worker (take it over interactively)'}
    >
      {pending ? 'attaching...' : error ? 'retry' : 'attach'}
    </span>
  )
}
