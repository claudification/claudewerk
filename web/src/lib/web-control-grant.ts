/**
 * Web Debug Control -- client-side opt-in grant (localStorage).
 *
 * The browser must OPT IN before the agent can drive it. Opting in writes a
 * time-boxed grant to localStorage; it survives full reload / SW update / app
 * /clear because localStorage does. On every WS (re)connect the client
 * re-advertises the grant (see use-websocket onopen), so the agent keeps
 * targeting the SAME stable clientId even though the socket's connectionId
 * rotates. DEFAULT-DENY: no live grant here -> the dispatcher refuses every op
 * and the client never advertises, so the broker never targets it.
 *
 * Pure module: no WS imports (avoids a cycle with use-conversations). Callers
 * send the advertise/revoke payloads this module builds.
 */

import { WEB_CONTROL_MAX_GRANT_MS, WEB_CONTROL_OPS, type WebControlOp } from '@shared/protocol'

const CLIENT_ID_KEY = 'webControl.clientId'
const GRANT_KEY = 'webControl.grant'

export interface WebControlGrant {
  grantId: string
  expiresAt: number
}

/** Stable per-browser id (permanent). The agent targets THIS. */
function getWebControlClientId(): string {
  try {
    let id = localStorage.getItem(CLIENT_ID_KEY)
    if (!id) {
      id = `web_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
      localStorage.setItem(CLIENT_ID_KEY, id)
    }
    return id
  } catch {
    // Private mode / storage disabled: fall back to an ephemeral id.
    return `web_${crypto.randomUUID().replace(/-/g, '').slice(0, 16)}`
  }
}

/** The ops this browser will perform when opted-in (single grant = all ops). */
function webControlCapabilities(): WebControlOp[] {
  return [...WEB_CONTROL_OPS]
}

/** A human label for the agent's client picker, e.g. "jonas - macOS / Chrome". */
function webControlLabel(userName?: string): string {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  let browser = 'browser'
  if (/Edg\//.test(ua)) browser = 'Edge'
  else if (/Chrome\//.test(ua)) browser = 'Chrome'
  else if (/Firefox\//.test(ua)) browser = 'Firefox'
  else if (/Safari\//.test(ua)) browser = 'Safari'
  let os = ''
  if (/Mac|iPhone|iPad/.test(ua)) os = 'macOS/iOS'
  else if (/Windows/.test(ua)) os = 'Windows'
  else if (/Android/.test(ua)) os = 'Android'
  else if (/Linux/.test(ua)) os = 'Linux'
  const who = userName ? `${userName} - ` : ''
  return `${who}${[os, browser].filter(Boolean).join(' / ')}`
}

// ── Reactive grant state (useSyncExternalStore-friendly) ─────────────────

let grant: WebControlGrant | null | undefined // undefined = not yet loaded
const listeners = new Set<() => void>()

function load(): WebControlGrant | null {
  if (grant !== undefined) return grant
  try {
    const raw = localStorage.getItem(GRANT_KEY)
    grant = raw ? (JSON.parse(raw) as WebControlGrant) : null
  } catch {
    grant = null
  }
  return grant
}

function set(next: WebControlGrant | null): void {
  grant = next
  try {
    if (next) localStorage.setItem(GRANT_KEY, JSON.stringify(next))
    else localStorage.removeItem(GRANT_KEY)
  } catch {
    /* storage disabled */
  }
  for (const l of listeners) l()
}

/** The active (non-expired) grant, or null. Lazily clears an expired one. */
export function getActiveWebControlGrant(): WebControlGrant | null {
  const g = load()
  if (!g) return null
  if (Date.now() >= g.expiresAt) {
    set(null)
    return null
  }
  return g
}

/** Opt in: create a fresh 1h grant. */
export function enableWebControl(): WebControlGrant {
  const g: WebControlGrant = {
    grantId: `g_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`,
    expiresAt: Date.now() + WEB_CONTROL_MAX_GRANT_MS,
  }
  set(g)
  return g
}

/** Opt out. */
export function disableWebControl(): void {
  set(null)
}

export function subscribeWebControl(cb: () => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

/** Stable snapshot for useSyncExternalStore (same ref until grant changes). */
export function getWebControlSnapshot(): WebControlGrant | null {
  return load()
}

// ── Wire payload builders (caller sends them) ────────────────────────────

/** Payload for `web_control_advertise`, or null when no active grant. */
export function buildWebControlAdvertise(userName?: string): {
  clientId: string
  grantId: string
  expiresAt: number
  capabilities: WebControlOp[]
  label: string
} | null {
  const g = getActiveWebControlGrant()
  if (!g) return null
  return {
    clientId: getWebControlClientId(),
    grantId: g.grantId,
    expiresAt: g.expiresAt,
    capabilities: webControlCapabilities(),
    label: webControlLabel(userName),
  }
}

/** Payload for `web_control_revoke`. */
export function buildWebControlRevoke(): { clientId: string } {
  return { clientId: getWebControlClientId() }
}
