/**
 * Web Push subscription client.
 *
 * Both halves of a subscription must move together: the browser's
 * PushSubscription and the broker's per-user record. Tear down only the broker
 * record and getPushStatus()'s re-sync puts it straight back on the next load,
 * which is exactly how "unregister" used to do nothing.
 */

const API_BASE = ''

export interface PushResult {
  success: boolean
  error?: string
}

export interface PushStatus {
  supported: boolean
  subscribed: boolean
  permission: string
}

function pushSupported(): boolean {
  return 'serviceWorker' in navigator && 'PushManager' in window
}

/** The live browser subscription, or null if there isn't one (or SW is absent). */
async function currentSubscription(): Promise<PushSubscription | null> {
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js')
    if (!registration) return null
    return await registration.pushManager.getSubscription()
  } catch {
    return null
  }
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) return `${error.name}: ${error.message}`
  if (error instanceof Error) return error.message
  return 'Unknown error'
}

export async function subscribeToPush(): Promise<PushResult> {
  try {
    if (!pushSupported()) return { success: false, error: 'Push notifications not supported' }

    console.log('[push] Fetching VAPID key...')
    const vapidRes = await fetch(`${API_BASE}/api/push/vapid`)
    if (!vapidRes.ok) {
      console.error('[push] VAPID fetch failed:', vapidRes.status)
      return { success: false, error: 'Push not configured on server' }
    }
    const { publicKey } = await vapidRes.json()
    console.log('[push] Got VAPID key:', `${publicKey?.slice(0, 12)}...`)

    console.log('[push] Registering service worker...')
    const registration = await navigator.serviceWorker.register('/sw.js')
    await navigator.serviceWorker.ready
    console.log('[push] Service worker ready')

    const permission = await Notification.requestPermission()
    console.log('[push] Permission:', permission)
    if (permission !== 'granted') return { success: false, error: `Permission ${permission}` }

    console.log('[push] Subscribing to push manager...')
    const subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
    })
    console.log('[push] Got subscription:', `${subscription.endpoint.slice(0, 50)}...`)

    const subRes = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    console.log('[push] Subscribe response:', subRes.status)
    if (!subRes.ok) return { success: false, error: 'Failed to register subscription' }

    return { success: true }
  } catch (error: unknown) {
    const msg = describeError(error)
    console.error('[push] Subscribe error:', msg, error)
    return { success: false, error: msg }
  }
}

/**
 * Turn push OFF. Drops the broker's record AND the browser subscription --
 * both, in that order, and the browser one even if the broker call fails, so a
 * flaky network can't leave a zombie that getPushStatus() re-syncs back to life.
 */
export async function unsubscribeFromPush(): Promise<PushResult> {
  const subscription = await currentSubscription()
  if (!subscription) {
    console.log('[push] Unsubscribe: nothing subscribed, nothing to do')
    return { success: true }
  }

  const endpoint = subscription.endpoint
  let brokerError: string | undefined

  try {
    const res = await fetch(`${API_BASE}/api/push/unsubscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint }),
    })
    console.log('[push] Unsubscribe response:', res.status)
    if (!res.ok) brokerError = `Server returned ${res.status}`
  } catch (error: unknown) {
    brokerError = describeError(error)
    console.error('[push] Unsubscribe request failed:', brokerError)
  }

  try {
    await subscription.unsubscribe()
    console.log('[push] Browser subscription revoked:', `${endpoint.slice(0, 50)}...`)
  } catch (error: unknown) {
    const msg = describeError(error)
    console.error('[push] Browser unsubscribe failed:', msg)
    return { success: false, error: msg }
  }

  return brokerError ? { success: false, error: brokerError } : { success: true }
}

export async function getPushStatus(): Promise<PushStatus> {
  const supported = pushSupported()
  if (!supported) return { supported, subscribed: false, permission: 'unsupported' }

  const permission = Notification.permission
  const subscription = await currentSubscription()
  if (!subscription) return { supported, subscribed: false, permission }

  // The browser has one -- make sure the broker knows about it too, by
  // re-sending (idempotent). Covers a browser subscribe whose server POST
  // failed. Only reachable while a live subscription exists, so this can't
  // resurrect one that was deliberately unsubscribed.
  try {
    const res = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ subscription: subscription.toJSON() }),
    })
    console.log('[push] Re-synced subscription to server:', res.status)
    return { supported, subscribed: res.ok, permission }
  } catch {
    // Server unreachable -- still show as subscribed locally.
    return { supported, subscribed: true, permission }
  }
}

function urlBase64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4)
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/')
  const rawData = window.atob(base64)
  const outputArray = new Uint8Array(rawData.length)
  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i)
  }
  return outputArray
}
