import { Bell, BellOff } from 'lucide-react'
import { useEffect, useState } from 'react'
import { getPushStatus, subscribeToPush, unsubscribeFromPush } from '@/lib/push'
import { PUSH_BUSY, PUSH_STATE_STYLES, type PushState } from './notifications-section-states'

export function NotificationsSection() {
  const [pushState, setPushState] = useState<PushState>('loading')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    getPushStatus().then(status => {
      if (!status.supported) setPushState('unsupported')
      else if (status.subscribed) setPushState('subscribed')
      else if (status.permission === 'denied') setPushState('denied')
      else setPushState('prompt')
    })
  }, [])

  async function enable() {
    setError(null)
    setPushState('subscribing')
    const result = await subscribeToPush()
    if (!result.success) setError(result.error ?? null)
    setPushState(result.success ? 'subscribed' : 'denied')
  }

  async function disable() {
    setError(null)
    setPushState('unsubscribing')
    const result = await unsubscribeFromPush()
    if (!result.success) setError(result.error ?? null)
    // Even on a partial failure the browser subscription is gone, so the honest
    // state is "off". Permission stays granted, so re-enabling is one click.
    setPushState('prompt')
  }

  function handlePushToggle() {
    if (PUSH_BUSY.has(pushState)) return
    return pushState === 'subscribed' ? disable() : enable()
  }

  /** Drop both halves and re-subscribe -- for when the VAPID key rotated. */
  async function handleReRegister() {
    if (PUSH_BUSY.has(pushState)) return
    setPushState('unsubscribing')
    await unsubscribeFromPush()
    await enable()
  }

  const style = PUSH_STATE_STYLES[pushState]

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm text-foreground">Push notifications</div>
          <div className="text-[10px] text-muted-foreground">Get notified when Claude needs input</div>
        </div>
        <button
          type="button"
          onClick={handlePushToggle}
          disabled={pushState === 'unsupported' || pushState === 'loading'}
          title={pushState === 'subscribed' ? 'Click to turn push notifications off' : undefined}
          className={`flex items-center gap-1.5 px-3 py-1.5 text-xs border transition-colors ${style.className}`}
        >
          {style.bell ? <Bell className="size-3" /> : <BellOff className="size-3" />}
          {style.label}
        </button>
      </div>
      {error && <div className="text-[10px] text-red-400">{error}</div>}
      {pushState === 'subscribed' && (
        <button
          type="button"
          onClick={handleReRegister}
          className="text-[10px] text-muted-foreground hover:text-foreground underline underline-offset-2 transition-colors"
        >
          Re-register push (use after VAPID key change)
        </button>
      )}
    </div>
  )
}
