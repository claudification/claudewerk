/**
 * THE ORB'S STATUS SUBSCRIPTIONS -- which conversations a given orb has asked to
 * be told about.
 *
 * The orb is a browser surface that comes and goes; the STATUSES arrive at the
 * broker whether or not anyone is summoned. So the subscription lives here, keyed
 * by the orb instance id (the one in the browser's localStorage, stable across
 * summons and reloads), and the relay (orb-status-relay.ts) consults it on every
 * `agent_status`.
 *
 * IN-MEMORY ON PURPOSE. A watch is an attention preference for the session the
 * user is having right now, not a durable setting -- surviving a broker restart
 * would mean the orb starts narrating a project the user forgot they subscribed
 * to three days ago. Restart clears them; the user re-asks in one sentence.
 *
 * Three bounds keep a runaway subscription from becoming a firehose:
 *   - TTL      a watch goes quiet on its own, so a forgotten one cannot narrate forever
 *   - PATTERNS a cap per orb, so "watch this too" cannot accumulate without limit
 *   - ORBS     an LRU cap, so stale browser ids cannot grow the map unbounded
 */

import { matchesAnyPattern, normalizeAddressPattern } from '../../shared/conversation-address'

/** How long a watch stays live without being re-stated. Long enough to span a
 *  working session, short enough that yesterday's watch is gone today. */
export const WATCH_TTL_MS = 8 * 60 * 60_000

/** Most patterns one orb may hold. Past this the model is hoarding, not watching. */
export const MAX_PATTERNS_PER_ORB = 12

/** Most orb instances tracked at once; the least-recently-touched is evicted. */
const MAX_ORBS = 32

/** The bare address every orb answers to when a message names no instance. */
const ANY_ORB = '*'

interface WatchRecord {
  patterns: string[]
  /** Epoch ms after which this record is dead. Refreshed on every change. */
  expiresAt: number
  /** Epoch ms of the last touch -- the LRU key. */
  touchedAt: number
}

const watches = new Map<string, WatchRecord>()

/** Drop every expired record. Called on each read so a dead watch can never be
 *  matched, without needing a timer. */
function sweep(now: number): void {
  for (const [orbId, rec] of watches) {
    if (rec.expiresAt <= now) watches.delete(orbId)
  }
}

/** Evict the least-recently-touched orbs down to the cap. */
function evict(): void {
  if (watches.size <= MAX_ORBS) return
  const byAge = [...watches.entries()].sort((a, b) => a[1].touchedAt - b[1].touchedAt)
  for (const [orbId] of byAge.slice(0, watches.size - MAX_ORBS)) watches.delete(orbId)
}

/** The patterns an orb currently watches (empty when it watches nothing). */
export function getWatchPatterns(orbId: string | null, now: number = Date.now()): string[] {
  sweep(now)
  const rec = watches.get(orbId ?? ANY_ORB)
  return rec ? [...rec.patterns] : []
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
  /** Epoch ms this watch goes quiet on its own. Null when nothing is watched. */
  expiresAt: number | null
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

/** Apply a mode to the existing pattern list. Pure -- the caps and the store
 *  writes stay in `applyWatch`. */
function nextPatterns(mode: WatchMode, existing: string[], incoming: string[]): string[] {
  if (mode === 'clear') return []
  if (mode === 'list') return existing
  if (mode === 'replace') return incoming
  if (mode === 'remove') return existing.filter(p => !incoming.includes(p))
  return [...existing, ...incoming.filter(p => !existing.includes(p))]
}

/**
 * Add / remove / replace / clear / list one orb's watches.
 *
 * `list` is a read that still sweeps and refreshes nothing -- asking what you
 * watch must not extend how long you watch it.
 */
export function applyWatch(
  orbId: string | null,
  mode: WatchMode,
  rawPatterns: readonly string[] = [],
  now: number = Date.now(),
): WatchChange {
  sweep(now)
  const key = orbId ?? ANY_ORB
  const existing = watches.get(key)?.patterns ?? []

  if (mode === 'list') {
    const rec = watches.get(key)
    return { patterns: [...existing], rejected: [], clipped: false, expiresAt: rec?.expiresAt ?? null }
  }

  const { ok, rejected } = normalizeAll(rawPatterns)
  const merged = nextPatterns(mode, existing, ok)
  const patterns = merged.slice(0, MAX_PATTERNS_PER_ORB)
  const clipped = merged.length > patterns.length

  if (patterns.length === 0) {
    watches.delete(key)
    return { patterns: [], rejected, clipped, expiresAt: null }
  }

  const expiresAt = now + WATCH_TTL_MS
  watches.set(key, { patterns, expiresAt, touchedAt: now })
  evict()
  return { patterns: [...patterns], rejected, clipped, expiresAt }
}

/**
 * Every orb that has asked about this address.
 *
 * An orb watching under the bare `*` key (a panel too old to send an instance
 * id) is returned as `null`, which the relay turns back into a broadcast to all
 * of the user's panels -- the same null-means-everyone rule the orb channel and
 * `dispatch_quest` already use.
 */
export function matchingOrbs(address: string, now: number = Date.now()): (string | null)[] {
  sweep(now)
  const out: (string | null)[] = []
  for (const [orbId, rec] of watches) {
    if (matchesAnyPattern(rec.patterns, address)) out.push(orbId === ANY_ORB ? null : orbId)
  }
  return out
}

/** Test seam: forget every watch. */
export function resetWatches(): void {
  watches.clear()
}
