import { useEffect, useState, useSyncExternalStore } from 'react'
import { turnOffWebControl, turnOnWebControl } from '@/lib/web-control-actions'
import { getActiveWebControlGrant, getWebControlSnapshot, subscribeWebControl } from '@/lib/web-control-grant'

/**
 * Settings toggle for "Allow agent remote-control". Self-contained: reads the
 * localStorage grant via useSyncExternalStore, ticks once a second to update the
 * countdown and auto-expire, and routes opt-in/out through the shared actions.
 */
export function WebControlToggle({ ariaLabel }: { ariaLabel?: string }) {
  const grant = useSyncExternalStore(subscribeWebControl, getWebControlSnapshot, () => null)
  const [, forceTick] = useState(0)

  useEffect(() => {
    const t = setInterval(() => {
      // Clears + notifies subscribers when the grant crosses its expiry.
      getActiveWebControlGrant()
      forceTick(n => n + 1)
    }, 1000)
    return () => clearInterval(t)
  }, [])

  const active = !!grant && Date.now() < grant.expiresAt
  const msLeft = active && grant ? grant.expiresAt - Date.now() : 0
  const minsLeft = Math.max(0, Math.ceil(msLeft / 60000))

  return (
    <div className="flex items-center gap-2">
      <input
        aria-label={ariaLabel}
        type="checkbox"
        checked={active}
        onChange={e => (e.target.checked ? turnOnWebControl() : turnOffWebControl())}
        className="accent-primary size-4"
      />
      {active && (
        <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
          <span className="tabular-nums">{minsLeft}m left</span>
          <button
            type="button"
            onClick={turnOnWebControl}
            className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
          >
            Renew
          </button>
        </span>
      )}
    </div>
  )
}
