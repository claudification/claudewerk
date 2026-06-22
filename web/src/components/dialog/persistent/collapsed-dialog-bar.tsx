/**
 * THE DIALOGUE (D2) — the minimized representation of a live dialog: a slim
 * inline bar that sits where the card was, so the user can read the transcript
 * behind it. Two flavours:
 *
 *   - MINIMIZED (user pressed minus): live pulse, "tap to expand", full opacity,
 *     no decay -- it stays until the user restores or dismisses it.
 *   - CLOSED (the agent closed the dialog): the bar fades over the decay window
 *     (CLOSED_DECAY_MS) as a "this was here" trace, then the mount hard-removes
 *     it. The user can reopen (tap) or dismiss (x) at any point before that.
 *
 * Eager + tiny on purpose: while collapsed we do NOT load the heavy dialog
 * renderer chunk (LAZY LOAD covenant) -- this bar carries everything it needs.
 */
import { CircleDot, Maximize2, X } from 'lucide-react'
import { memo, useEffect, useState } from 'react'
import { CLOSED_DECAY_MS } from '@/hooks/use-live-dialogs'
import { cn, haptic } from '@/lib/utils'
import { decodeEntities } from '../decode-entities'

interface CollapsedDialogBarProps {
  title: string
  /** epoch ms the agent closed it; undefined = a plain user minimize (no decay). */
  closedAt?: number
  onExpand: () => void
  onDismiss: () => void
}

export const CollapsedDialogBar = memo(function CollapsedDialogBar({
  title,
  closedAt,
  onExpand,
  onDismiss,
}: CollapsedDialogBarProps) {
  const closed = closedAt !== undefined
  // Fade from its current age-adjusted opacity down to a faint trace over the
  // time left before the hard removal -- one CSS transition, no ticking timer.
  const elapsed = closedAt ? Date.now() - closedAt : 0
  const remaining = closedAt ? Math.max(0, closedAt + CLOSED_DECAY_MS - Date.now()) : 0
  const startOpacity = closed ? Math.max(0.4, 1 - 0.6 * (elapsed / CLOSED_DECAY_MS)) : 1
  const [faded, setFaded] = useState(false)
  useEffect(() => {
    if (!closed) return
    const id = requestAnimationFrame(() => setFaded(true))
    return () => cancelAnimationFrame(id)
  }, [closed])

  return (
    <div className="mx-2 my-2">
      <div
        style={
          closed ? { opacity: faded ? 0.4 : startOpacity, transition: `opacity ${remaining}ms linear` } : undefined
        }
        className={cn(
          'flex items-center gap-2 rounded-lg border bg-card/80 px-3 py-1.5 shadow-sm backdrop-blur',
          'animate-in fade-in slide-in-from-top-1 duration-200',
          closed ? 'border-zinc-500/30' : 'border-primary/30',
        )}
      >
        <button
          type="button"
          onClick={() => {
            haptic('tap')
            onExpand()
          }}
          className="group flex min-w-0 flex-1 items-center gap-2 text-left"
          title={closed ? 'Reopen this dialog' : 'Expand this dialog'}
        >
          {closed ? (
            <CircleDot className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <span className="relative flex size-2 shrink-0">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-primary/70" />
              <span className="relative inline-flex size-2 rounded-full bg-primary" />
            </span>
          )}
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground transition-colors group-hover:text-primary">
              {decodeEntities(title)}
            </span>
            <span className="block text-[10px] uppercase tracking-wide text-muted-foreground">
              {closed ? 'dialog closed - tap to reopen' : 'minimized - tap to expand'}
            </span>
          </span>
          <Maximize2 className="ml-auto size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100" />
        </button>
        <button
          type="button"
          onClick={() => {
            haptic('error')
            onDismiss()
          }}
          title="Dismiss (remove from view)"
          aria-label="Dismiss dialog"
          className="shrink-0 p-1 text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-4" />
        </button>
      </div>
    </div>
  )
})
