/**
 * THE CLIENT OWNS THE WATCH LIST.
 *
 * Status subscriptions are SOCKET-scoped on the broker (see
 * broker/desk/orb-status-watch.ts): a reconnect drops them, by design, because a
 * socket is the only thing that gives the broker an exact end-of-life signal.
 * That trade only works if somebody else remembers what was wanted -- and that
 * somebody is this module.
 *
 * So the broker holds DERIVED state and this holds the truth. There is only ever
 * one authoritative copy, which is what stops the two drifting.
 *
 * Persisted to localStorage, alongside the orb instance id, so the list survives
 * a full page reload and not just a socket blip. It does NOT survive closing the
 * tab in any meaningful sense: nothing would be listening anyway. A watch that
 * should outlive the browser is a push notification, not a spoken line, and that
 * is a different feature.
 *
 * Kept free of React and of WebRTC so the WS layer can import it without
 * dragging in the lazy orb chunk.
 */

const STORAGE_KEY = 'rclaude.orbWatches'

let cached: string[] | null = null

function load(): string[] {
  if (cached) return cached
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    cached = Array.isArray(parsed) ? parsed.filter((p): p is string => typeof p === 'string') : []
  } catch {
    // Unreadable or malformed storage is not worth failing a summon over.
    cached = []
  }
  return cached
}

/** The patterns this browser wants watched. */
export function getOrbWatches(): string[] {
  return [...load()]
}

/**
 * Record what the broker says is in force.
 *
 * Always fed from a SERVER result (the tool's `watching`, or the assert reply),
 * never from what the model asked for -- the server normalizes, de-duplicates,
 * drops junk and applies the cap, so storing the request instead of the outcome
 * would replay patterns that were already refused once.
 */
export function setOrbWatches(patterns: readonly string[]): void {
  cached = [...patterns]
  try {
    if (cached.length === 0) localStorage.removeItem(STORAGE_KEY)
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(cached))
  } catch {
    /* in-memory is still correct for this session */
  }
}

export type WatchSender = (msg: { type: string; patterns: string[] }) => void

/**
 * Re-establish this browser's subscriptions on a fresh socket.
 *
 * Mirrors `resubscribeAgentScopes`: the broker forgot, the client did not. Sends
 * nothing when there is nothing to say, so an orb that never subscribed costs no
 * traffic. The broker treats it as a REPLACE, so a duplicate assert converges
 * rather than accumulating.
 */
export function reassertOrbWatches(send: WatchSender): void {
  const patterns = load()
  if (patterns.length === 0) return
  send({ type: 'voice_watch_assert', patterns })
}

/** Stop watching entirely (orb dismissed, or the user cleared it). */
export function clearOrbWatches(send?: WatchSender): void {
  setOrbWatches([])
  send?.({ type: 'voice_watch_assert', patterns: [] })
}

/**
 * Mirror a `watch_conversations` tool result into the stored list.
 *
 * The model's call goes straight to the broker, so this is the only point where
 * the client learns that the list changed. Recording the RESULT (not the
 * request) is what keeps the replay honest: patterns the server rejected or
 * clipped never make it into storage, so a reconnect cannot resurrect them.
 *
 * Silently ignores every other tool and every failure -- a failed call changed
 * nothing server-side, so the stored list is still correct.
 */
export function recordWatchToolResult(msg: { name?: string; ok?: boolean; result?: unknown }): void {
  if (msg.name !== 'watch_conversations' || !msg.ok) return
  const watching = (msg.result as { watching?: unknown } | undefined)?.watching
  if (!Array.isArray(watching)) return
  setOrbWatches(watching.filter((p): p is string => typeof p === 'string'))
}
