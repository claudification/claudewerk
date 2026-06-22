/**
 * THE DIALOGUE (D2) — per-viewer view prefs for a live dialog, persisted to
 * localStorage. Minimize/dismiss/collapse is a PER-VIEWER UI preference, not
 * shared dialog state: the broker's single `conv.liveDialog` slot is seen by
 * every panel, so persisting "dismissed" server-side would hide the dialog for
 * everyone. We keep it client-side + per-device, scoped to the current dialogId
 * (a new dialogId supersedes a stale dismiss).
 */

const KEY = 'claudewerk.dialogView.v1'

export interface DialogViewPref {
  /** The dialog these prefs apply to -- a different id makes them stale. */
  dialogId: string
  /** Minimized into the bar (manual) -- survives reload. */
  collapsed: boolean
  /** Hard-dismissed from this client's view -- survives reload. */
  dismissed: boolean
  /** epoch ms the agent closed it (drives decay continuity across reload). */
  closedAt?: number
}

type PrefsMap = Record<string, DialogViewPref>

/** localStorage is absent in node/bun test runs (and can throw in private mode). */
function storage(): Storage | null {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : null
  } catch {
    return null
  }
}

let cache: PrefsMap | null = null

function load(): PrefsMap {
  if (cache) return cache
  const raw = storage()?.getItem(KEY)
  cache = raw ? parse(raw) : {}
  return cache
}

function parse(raw: string): PrefsMap {
  try {
    const parsed = JSON.parse(raw) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as PrefsMap) : {}
  } catch {
    return {}
  }
}

function flush(map: PrefsMap): void {
  cache = map
  try {
    storage()?.setItem(KEY, JSON.stringify(map))
  } catch {
    // quota / private mode -- the in-memory cache still holds this session.
  }
}

export function getPref(conversationId: string): DialogViewPref | undefined {
  return load()[conversationId]
}

export function setPref(conversationId: string, pref: DialogViewPref): void {
  flush({ ...load(), [conversationId]: pref })
}

export function clearPref(conversationId: string): void {
  const map = load()
  if (!(conversationId in map)) return
  const { [conversationId]: _gone, ...rest } = map
  flush(rest)
}

/** Test-only: drop the in-memory cache so the next read re-hits storage. */
export function resetDialogPrefsCache(): void {
  cache = null
}
