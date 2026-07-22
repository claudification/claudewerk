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
const ID_LEN = 6
const ID_CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789'

let cached: string | null = null

/** A SHORT id -- `orb:k7p2qz` -- because it is said aloud and passed between the
 *  orb and conversations. 6 base36 chars (~2 billion) is plenty for one user's
 *  handful of devices, and speakable in a way a 36-char UUID never is. */
function mintShortId(): string {
  const r = crypto.getRandomValues(new Uint8Array(ID_LEN))
  return Array.from(r, b => ID_CHARS[b % 36]).join('')
}

/** A stored value we trust: exactly our short format. Anything else (the old
 *  UUID scheme, junk) is re-minted so no device is stuck on an unspeakable id. */
function isShortId(v: string): boolean {
  return v.length === ID_LEN && /^[a-z0-9]+$/.test(v)
}

/** Stable per-browser id, created (or migrated) on first read. Falls back to an
 *  in-memory id if localStorage is unavailable (private mode) -- still unique per
 *  tab-session, just not durable, which only weakens targeted replies. */
export function getOrbInstanceId(): string {
  if (cached) return cached
  try {
    const existing = localStorage.getItem(STORAGE_KEY)
    if (existing && isShortId(existing)) {
      cached = existing
      return existing
    }
    const fresh = mintShortId()
    localStorage.setItem(STORAGE_KEY, fresh)
    cached = fresh
    return fresh
  } catch {
    cached ??= mintShortId()
    return cached
  }
}

/** Should THIS browser speak a delivery aimed at `targetOrbId`? null/empty =
 *  broadcast to all, so yes; otherwise only when it is our own id. */
export function isForThisOrb(targetOrbId: string | null | undefined): boolean {
  if (!targetOrbId) return true
  return targetOrbId === getOrbInstanceId()
}
