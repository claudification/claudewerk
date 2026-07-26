/**
 * Regression tests for the "can't un-register from notifications" bug.
 *
 * Two defects, stacked:
 *
 *  1. Nothing in the control panel ever called `/api/push/unsubscribe`. The
 *     broker route existed with zero callers, and the settings toggle called
 *     subscribeToPush() unconditionally -- so once you were on, you were on.
 *
 *  2. Even a server-side-only unsubscribe resurrects itself: getPushStatus()
 *     re-POSTs the browser's still-live PushSubscription to /api/push/subscribe
 *     on every load ("re-sync"). Killing the server record without also calling
 *     PushSubscription.unsubscribe() means the next page load puts it back.
 *
 * So the contract under test is: unsubscribeFromPush() tears down BOTH sides,
 * and getPushStatus() afterwards reports not-subscribed without re-syncing.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { getPushStatus, unsubscribeFromPush } from './push'

const ENDPOINT = 'https://push.example.test/sub/abc123'

function installServiceWorker(subscription: unknown) {
  const registration = {
    pushManager: {
      getSubscription: vi.fn(async () => subscription),
      subscribe: vi.fn(async () => subscription),
    },
  }
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: vi.fn(async () => registration),
      register: vi.fn(async () => registration),
      ready: Promise.resolve(registration),
    },
  })
  return registration
}

/** A live browser subscription that flips to "gone" once unsubscribe() runs. */
function makeLiveSubscription() {
  const sub = {
    endpoint: ENDPOINT,
    alive: true,
    toJSON: () => ({ endpoint: ENDPOINT, keys: { p256dh: 'p', auth: 'a' } }),
    unsubscribe: vi.fn(async () => {
      sub.alive = false
      return true
    }),
  }
  return sub
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn(async () => new Response(JSON.stringify({ success: true }), { status: 200 }))
  vi.stubGlobal('fetch', fetchMock)
  vi.stubGlobal('PushManager', function PushManager() {})
  // jsdom ships no Notification API.
  vi.stubGlobal('Notification', { permission: 'granted', requestPermission: vi.fn(async () => 'granted') })
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  Reflect.deleteProperty(navigator, 'serviceWorker')
})

describe('unsubscribeFromPush', () => {
  test('tells the broker to drop the endpoint', async () => {
    const sub = makeLiveSubscription()
    installServiceWorker(sub)

    const result = await unsubscribeFromPush()

    expect(result.success).toBe(true)
    const unsubCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/push/unsubscribe'))
    expect(unsubCall, 'expected a POST to /api/push/unsubscribe').toBeDefined()
    expect(unsubCall?.[1]?.method).toBe('POST')
    expect(JSON.parse(unsubCall?.[1]?.body as string)).toEqual({ endpoint: ENDPOINT })
  })

  test('also kills the browser-side subscription, so it cannot be re-synced', async () => {
    const sub = makeLiveSubscription()
    installServiceWorker(sub)

    await unsubscribeFromPush()

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1)
    expect(sub.alive).toBe(false)
  })

  test('is a no-op success when there is nothing subscribed', async () => {
    installServiceWorker(null)

    const result = await unsubscribeFromPush()

    expect(result.success).toBe(true)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  test('still tears down the browser subscription when the broker call fails', async () => {
    const sub = makeLiveSubscription()
    installServiceWorker(sub)
    fetchMock.mockRejectedValue(new Error('broker unreachable'))

    const result = await unsubscribeFromPush()

    expect(sub.unsubscribe).toHaveBeenCalledTimes(1)
    expect(result.success).toBe(false)
  })
})

describe('getPushStatus after unsubscribing', () => {
  test('reports not-subscribed and does not resurrect the subscription', async () => {
    const sub = makeLiveSubscription()
    const registration = installServiceWorker(sub)

    await unsubscribeFromPush()

    // Browser no longer hands out a subscription once it has been unsubscribed.
    registration.pushManager.getSubscription = vi.fn(async () => null)
    fetchMock.mockClear()

    const status = await getPushStatus()

    expect(status.subscribed).toBe(false)
    const resync = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/api/push/subscribe'))
    expect(resync, 'getPushStatus must not re-POST /api/push/subscribe after an unsubscribe').toBeUndefined()
  })
})
