/**
 * What a closed socket means, and what to do about it.
 *
 * Almost always: reconnect. The one case worth thinking about is an
 * "auth-coded" close, which is NOT trustworthy proof the session is dead --
 * so the policy proves auth state with a real request before locking the user
 * out behind the SESSION EXPIRED modal.
 */

import { failAllPendingSends } from '@/lib/pending-sends'
import { isShareView } from '@/lib/share-mode'
import { useConversationsStore } from './use-conversations'
import { resetWsRtt, setSocketDepthProbe } from './ws-rtt'
import type { TimerRef } from './ws-socket-types'

const RECONNECT_DELAY_MS = 2000

/** Close codes that LOOK auth-fatal: 4401 from the broker, 1008 from a proxy. */
const AUTH_CLOSE_CODES = new Set([1008, 4401])

/**
 * Build the `onclose` handler for one socket. `reconnect` re-enters the hook's
 * connect(); `reconnectTimeoutRef` is the hook's ref so unmount can disarm a
 * pending retry.
 */
export function createCloseHandler(reconnect: () => void, reconnectTimeoutRef: TimerRef) {
  const scheduleReconnect = () => {
    if (!reconnectTimeoutRef.current) {
      reconnectTimeoutRef.current = setTimeout(() => {
        reconnectTimeoutRef.current = null
        reconnect()
      }, RECONNECT_DELAY_MS)
    }
  }

  return (e: CloseEvent) => {
    // Every in-flight probe just became unanswerable and every sample in the
    // window describes a connection that no longer exists. Drop both, so the
    // tile dashes instead of holding a latency for a dead wire until the
    // window happens to age out.
    setSocketDepthProbe(null)
    resetWsRtt()

    // Sends still in flight can never be confirmed now -- queue them for
    // retry rather than letting a mid-post disconnect eat the text.
    const orphaned = failAllPendingSends('Connection lost mid-send')
    if (orphaned > 0) {
      console.warn(`[outbox] queued ${orphaned} unconfirmed message(s) after socket close (code ${e.code})`)
    }

    // Single setState for disconnect state (regardless of why we closed)
    useConversationsStore.setState({
      isConnected: false,
      ws: null,
      ...(e.code !== 1000 ? { error: `WebSocket closed (${e.code}${e.reason ? `: ${e.reason}` : ''})` } : {}),
    })

    if (AUTH_CLOSE_CODES.has(e.code)) {
      // Looks like auth death -- but verify before showing the modal. Never
      // trust the close code alone (backpressure now uses 4290, but proxies
      // still inject 1008, and a 4401 can fire on a transient broker race).
      void verifyAuthThenReconnect(e.code, e.reason, scheduleReconnect)
      return
    }

    scheduleReconnect()
  }
}

/**
 * An "auth-coded" WS close (4401 from the broker, or a 1008 injected by a
 * proxy / idle-timeout) is NOT trustworthy proof the session is dead. The
 * broker bounces sockets on transient conditions too, and the user's own
 * manual refresh almost always recovers -- which means the cookie is still
 * valid. So before locking the user out behind the SESSION EXPIRED modal,
 * prove auth state with a real authed request, exactly what a refresh does.
 * /auth/status is public (never 401s), reports { authenticated }, AND
 * silently renews the cookie, so a healthy session self-heals instead of
 * dead-ending. One retry covers a brief revoke/reload race on the broker.
 */
async function verifyAuthThenReconnect(code: number, reason: string, scheduleReconnect: () => void) {
  // Share-link guests authenticate with the share token, not a cookie, so
  // /auth/status would falsely report unauthenticated. Just reconnect.
  if (isShareView()) {
    scheduleReconnect()
    return
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 1500))
    try {
      const res = await fetch('/auth/status', { credentials: 'include', cache: 'no-store' })
      const data = (await res.json()) as { authenticated?: boolean }
      if (data?.authenticated) {
        console.warn(
          `[ws] close code=${code}${reason ? ` reason=${reason}` : ''} looked auth-fatal but /auth/status=authenticated -> transient, reconnecting`,
        )
        scheduleReconnect()
        return
      }
    } catch (err) {
      // Probe itself failed (network down) -> not proof of expiry. Reconnect.
      console.warn(`[ws] auth probe failed (${String(err)}) -> treating close code=${code} as transient, reconnecting`)
      scheduleReconnect()
      return
    }
  }
  // Probe consistently says unauthenticated -> genuine expiry/revoke. Lock down.
  console.warn(`[ws] close code=${code} confirmed unauthenticated by /auth/status -> session expired`)
  useConversationsStore.setState({ authExpired: true, error: 'Session expired' })
}
