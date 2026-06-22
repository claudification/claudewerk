import { useDispatchStore } from './dispatch-store'

/** Minimal desk header: identity + close. No stats, no fleet -- the concierge
 *  doesn't greet you with a dashboard. */
export function DispatchHeader() {
  const close = useDispatchStore(s => s.closeOverlay)

  return (
    <header className="flex flex-none items-center gap-2 px-6 pt-5 pb-1">
      <span className="inline-block h-2 w-2 rounded-full" style={{ background: 'var(--accent)' }} />
      <span className="text-[13px] font-semibold tracking-[0.18em] text-foreground">DISPATCH</span>
      <span className="text-[11px] text-comment">your desk</span>
      <button
        type="button"
        onClick={close}
        aria-label="Close dispatch (Esc)"
        className="ml-auto flex-none rounded-md px-2 py-1 text-[11px] text-comment hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
      >
        esc
      </button>
    </header>
  )
}
