/**
 * This browser's stable ORB INSTANCE ID -- the `xyz` in `orb:xyz`.
 *
 * `send_message to:"orb"` reaches every device the user has an orb open on;
 * `send_message to:"orb:<id>"` reaches only THIS browser. The id is per-browser
 * (localStorage), minted once and reused, so a conversation the orb hands its
 * address to can reply to the same device across summons and reloads.
 *
 * Filtering is client-side: the broker broadcasts every `voice_orb_deliver` to
 * all panels with a `targetOrbId`, and each browser keeps only the ones meant
 * for it (or the broadcast ones). No broker-side orb registry to keep in sync.
 */

const STORAGE_KEY = 'rclaude.orbInstanceId'

let cached: string | null = null

/** Stable per-browser id, created on first read. Falls back to an in-memory id
 *  if localStorage is unavailable (private mode) -- still unique per tab-session,
 *  just not durable, which only weakens targeted replies, never breaks them. */
export function getOrbInstanceId(): string {
  if (cached) return cached
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing) {
      cached = existing
      return existing
    }
    const fresh = crypto.randomUUID()
    localStorage.setItem(STORAGE_KEY, fresh)
    cached = fresh
    return fresh
  } catch {
    cached ??= crypto.randomUUID()
    return cached
  }
}

/** Should THIS browser speak a delivery aimed at `targetOrbId`? null/empty =
 *  broadcast to all, so yes; otherwise only when it is our own id. */
export function isForThisOrb(targetOrbId: string | null | undefined): boolean {
  if (!targetOrbId) return true
  return targetOrbId === getOrbInstanceId()
}
