/**
 * THE ORB'S STATUS SUBSCRIPTIONS -- which conversations a given control-panel
 * SOCKET has asked to be told about.
 *
 * KEYED ON THE SOCKET, and that is the whole design. An earlier cut keyed on the
 * orb's localStorage instance id, which sounds more durable and is actually
 * worse: nothing ever tells the broker that such a subscription is dead, so it
 * needed a TTL and an LRU invented purely to bound a map with no natural end.
 * A socket has an exact end. Keying on it means:
 *   - cleanup is a fact (`forgetWatcher` on close), not a guess after 8 hours,
 *   - the authed identity is re-checked on every reconnect, because a fresh
 *     socket carries fresh `grants` -- a stable orb id carries nothing,
 *   - a watch can never outlive the thing that would speak it, so the relay
 *     never computes matches for a panel nobody has open.
 *
 * The cost is that a reconnect drops every subscription. That is correct and
 * intended: THE CLIENT OWNS THE LIST. The panel re-asserts what it wants on
 * connect (`voice_watch_assert`), exactly as it already re-asserts agent-scope
 * channel subscriptions. Broker state here is DERIVED, never authoritative --
 * so there is only ever one copy of the truth to drift.
 *
 * Ephemeral by construction. A durable "tell me when X breaks even with nothing
 * connected" is a different feature with a different sink (a push, not a spoken
 * line) and would duplicate the existing needs_you push path.
 */

import { matchesAnyPattern, normalizeAddressPattern } from '../../shared/conversation-address'

/** Most patterns one socket may hold. Not a correctness bound (the socket close
 *  is that) -- just a guard against a model that keeps piling watches on. */
export const MAX_PATTERNS_PER_WATCHER = 12

/** What the relay needs of a subscriber: something to send to, and the auth
 *  slice to check before doing so. Structural on purpose -- this module never
 *  needs to know it is a WebSocket. */
export interface WatcherSocket {
  send(data: string): void
  data?: unknown
}

/** Insertion-ordered so delivery order is stable across a fan-out. */
const watches = new Map<WatcherSocket, string[]>()

/** The patterns this socket currently watches (empty when it watches nothing). */
export function getWatchPatterns(ws: WatcherSocket): string[] {
  return [...(watches.get(ws) ?? [])]
}

export interface WatchChange {
  /** The patterns in force after the change. */
  patterns: string[]
  /** Inputs that were not usable as patterns, echoed back verbatim so the caller
   *  can tell the user WHICH one it did not understand. */
  rejected: string[]
  /** True when the cap clipped the list -- silently dropping would read as
   *  "subscribed" when it was not. */
  clipped: boolean
}

export type WatchMode = 'add' | 'remove' | 'replace' | 'clear' | 'list'

/** Normalize the requested patterns, splitting the usable from the junk. */
function normalizeAll(raw: readonly string[]): { ok: string[]; rejected: string[] } {
  const ok: string[] = []
  const rejected: string[] = []
  for (const p of raw) {
    const norm = normalizeAddressPattern(p)
    if (norm) {
      if (!ok.includes(norm)) ok.push(norm)
    } else {
      rejected.push(p)
    }
  }
  return { ok, rejected }
}

/** Apply a mode to the existing pattern list. Pure -- the cap and the store
 *  write stay in `applyWatch`. */
function nextPatterns(mode: WatchMode, existing: string[], incoming: string[]): string[] {
  if (mode === 'clear') return []
  if (mode === 'list') return existing
  if (mode === 'replace') return incoming
  if (mode === 'remove') return existing.filter(p => !incoming.includes(p))
  return [...existing, ...incoming.filter(p => !existing.includes(p))]
}

/** Add / remove / replace / clear / list one socket's watches. */
export function applyWatch(ws: WatcherSocket, mode: WatchMode, rawPatterns: readonly string[] = []): WatchChange {
  const existing = watches.get(ws) ?? []
  if (mode === 'list') return { patterns: [...existing], rejected: [], clipped: false }

  const { ok, rejected } = normalizeAll(rawPatterns)
  const merged = nextPatterns(mode, existing, ok)
  const patterns = merged.slice(0, MAX_PATTERNS_PER_WATCHER)
  const clipped = merged.length > patterns.length

  if (patterns.length === 0) watches.delete(ws)
  else watches.set(ws, patterns)
  return { patterns: [...patterns], rejected, clipped }
}

/** Every socket that has asked about this address. */
export function matchingWatchers(address: string): WatcherSocket[] {
  const out: WatcherSocket[] = []
  for (const [ws, patterns] of watches) {
    if (matchesAnyPattern(patterns, address)) out.push(ws)
  }
  return out
}

/**
 * The socket went away. Called from `removeSubscriber`, which is the ONE place
 * that knows a control panel is gone -- this is the lifecycle signal the old
 * orb-id keying did not have, and the reason no TTL is needed.
 */
export function forgetWatcher(ws: WatcherSocket): void {
  watches.delete(ws)
}

/** True when anybody at all is watching -- lets the status handler skip the
 *  address computation entirely on a fleet with no orb up. */
export function hasWatchers(): boolean {
  return watches.size > 0
}

/** Test seam: forget every watch. */
export function resetWatches(): void {
  watches.clear()
}
