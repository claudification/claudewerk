import { useEffect, useState, useSyncExternalStore } from 'react'
import { setScriptExecution, turnOffWebControl, turnOnWebControl } from '@/lib/web-control-actions'
import {
  getActiveWebControlGrant,
  getWebControlSnapshot,
  isScriptEnabled,
  subscribeWebControl,
} from '@/lib/web-control-grant'
import {
  hasScreenShare,
  isScreenShareSupported,
  startScreenShare,
  stopScreenShare,
  subscribeScreenShare,
} from '@/lib/web-control-screen-capture'

/**
 * Settings toggle for "Allow agent remote-control". Self-contained: reads the
 * localStorage grant via useSyncExternalStore, ticks once a second to update the
 * countdown and auto-expire, and routes opt-in/out through the shared actions.
 *
 * When opted in, a "Share screen" button arms agent screenshots: getDisplayMedia
 * needs a user gesture, so the agent can't start it -- this button (a real click)
 * acquires the stream once and caches it for the grant.
 */
export function WebControlToggle({ ariaLabel }: { ariaLabel?: string }) {
  const grant = useSyncExternalStore(subscribeWebControl, getWebControlSnapshot, () => null)
  const sharing = useSyncExternalStore(subscribeScreenShare, hasScreenShare, () => false)
  const scriptOn = useSyncExternalStore(subscribeWebControl, isScriptEnabled, () => false)
  const [, forceTick] = useState(0)
  const [shareErr, setShareErr] = useState<string | null>(null)

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
  const shareSupported = isScreenShareSupported()

  async function onShare() {
    setShareErr(null)
    const r = await startScreenShare()
    if (!r.ok) setShareErr(r.error ?? 'screen share failed')
  }

  return (
    <div className="flex flex-col gap-1.5">
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
      {active && shareSupported && (
        <div className="flex flex-wrap items-center gap-2 pl-6 text-[11px] text-muted-foreground">
          {sharing ? (
            <>
              <span className="flex items-center gap-1 text-success">
                <span className="size-1.5 rounded-full bg-success" />
                Sharing screen (agent screenshots armed)
              </span>
              <button
                type="button"
                onClick={stopScreenShare}
                className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
              >
                Stop
              </button>
            </>
          ) : (
            <button
              type="button"
              onClick={onShare}
              className="rounded border border-border px-1.5 py-0.5 text-[10px] hover:bg-muted"
            >
              Share screen (enables agent screenshots)
            </button>
          )}
          {shareErr && <span className="text-destructive">{shareErr}</span>}
        </div>
      )}
      {active && !shareSupported && (
        <div className="pl-6 text-[11px] text-muted-foreground">
          Screenshots fall back to a DOM rasterizer here -- this browser blocks screen capture (Safari installed-app
          mode). Open the panel in a normal browser tab for true screen capture.
        </div>
      )}
      {active && (
        <label className="flex items-center gap-2 pl-6 text-[11px] text-muted-foreground">
          <input
            type="checkbox"
            checked={scriptOn}
            onChange={e => setScriptExecution(e.target.checked)}
            className="accent-destructive size-3.5"
          />
          <span>
            Allow script execution{' '}
            <span className="text-destructive/80">(lets the agent run arbitrary JS in this browser)</span>
          </span>
        </label>
      )}
    </div>
  )
}
