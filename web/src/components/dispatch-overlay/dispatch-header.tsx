import { cn } from '@/lib/utils'
import { useDispatchStore } from './dispatch-store'

/** Minimal desk header: identity + a verbose-state toggle + close. No stats, no
 *  fleet -- the concierge doesn't greet you with a dashboard. */
export function DispatchHeader() {
  const close = useDispatchStore(s => s.closeOverlay)
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
      <button
        type="button"
        onClick={close}
        aria-label="Close dispatch (Esc)"
        className="flex-none rounded-md px-2 py-1 text-[11px] text-comment hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        esc
      </button>
    </header>
  )
}
