/**
 * useWakeLock -- hold a Screen Wake Lock while `active`, so the device does not
 * dim or auto-lock. Used to keep a phone awake while the voice orb is live and
 * the user is talking rather than touching the screen.
 *
 * Two platform facts drive the shape:
 *  - The lock is RELEASED automatically whenever the page is hidden (tab
 *    backgrounded, or the user turns the screen off), so we re-acquire on
 *    `visibilitychange` back to visible while still active.
 *  - A `request()` in a hidden page rejects, so we only ask while visible.
 *
 * Unsupported browsers (older iOS < 16.4, some desktop) no-op silently -- the
 * only fallback is the hidden-looping-video hack, which is janky and eats
 * battery, so we do not ship one. A denied request is likewise swallowed: there
 * is nothing the user can do about it and nothing worth surfacing.
 */

import { useEffect } from 'react'

/** Minimal shape of the Screen Wake Lock API -- declared locally so the hook
 *  does not depend on the DOM lib carrying these types. */
interface WakeLockSentinelLike {
  release(): Promise<void>
}
interface WakeLockLike {
  request(type: 'screen'): Promise<WakeLockSentinelLike>
}

function getWakeLock(): WakeLockLike | null {
  const nav = navigator as Navigator & { wakeLock?: WakeLockLike }
  return nav.wakeLock ?? null
}

export function useWakeLock(active: boolean): void {
  useEffect(() => {
    if (!active) return
    const wl = getWakeLock()
    if (!wl) return // API absent -- nothing to hold, no-op.

    let sentinel: WakeLockSentinelLike | null = null
    let cancelled = false

    const acquire = async () => {
      // Asking while hidden rejects; the visibility handler re-tries on return.
      if (cancelled || sentinel || document.visibilityState !== 'visible') return
      try {
        sentinel = await wl.request('screen')
        // Torn down (active -> false, or unmount) while the request was in
        // flight -- release at once instead of leaking a held lock.
        if (cancelled) {
          void sentinel.release().catch(() => {})
          sentinel = null
        }
      } catch {
        sentinel = null // denied / not allowed -- nothing to do.
      }
    }

    const onVisibility = () => {
      if (document.visibilityState === 'visible') {
        void acquire()
      } else {
        // The platform RELEASES the lock when the page hides. Drop our stale
        // handle so the next `acquire()` re-requests instead of short-circuiting
        // on a sentinel that no longer holds anything.
        sentinel = null
      }
    }

    void acquire()
    document.addEventListener('visibilitychange', onVisibility)

    return () => {
      cancelled = true
      document.removeEventListener('visibilitychange', onVisibility)
      void sentinel?.release().catch(() => {})
      sentinel = null
    }
  }, [active])
}
