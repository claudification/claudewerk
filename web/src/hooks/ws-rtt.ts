/**
 * WebSocket ROUND TRIP + queue depth -- the measured half of P4's socket tile.
 *
 * Sibling of `ws-stats.ts` and deliberately the same shape (module-level state,
 * `useSyncExternalStore`, no React state per sample) so the tile reads one more
 * store instead of growing a render path. What it does NOT share with ws-stats
 * is the always-on interval: ws-stats ticks from import for the lifetime of the
 * tab because counting bytes we already received costs nothing. THIS one puts a
 * message on the wire, so it only runs while something is on screen to read it
 * -- `acquireRttProbe` / `releaseRttProbe`, refcounted exactly like
 * `wall-subscription.ts`. No wall open, no probe. Nothing heartbeats the broker
 * for a number nobody is looking at.
 *
 * ONE SAMPLE IS NOT A MEASUREMENT. A single round trip over a network path is a
 * coin flip -- one GC pause, one retransmit, and the tile is lying. So the tile
 * reads a MEDIAN over a rolling window and the store dashes until the first pong
 * comes back. `src/broker/routes/api.ts` reaches the same conclusion for the
 * voice probe (and additionally discards its handshake round); the difference
 * here is that the probe repeats forever, so the window does that job instead.
 *
 * THE CLOCK IS `performance.now()`, for both the interval and the sample ages: it
 * is monotonic, so an NTP step mid-flight cannot manufacture a 4-hour round trip
 * or a negative one. Sub-millisecond resolution is coarsened by the browser's
 * timer-attack mitigations, which is fine -- we are measuring tens of ms.
 *
 * QUEUE DEPTH is two honest numbers from two different places and they are not
 * the same thing:
 *   - `queued`   -- the deepest rAF flush backlog seen since the last tick, i.e.
 *                   messages that arrived and are waiting for React. Sampled as
 *                   a high-water mark rather than instantaneously, because the
 *                   rAF drains in ~16 ms and a 5-second sample would read 0
 *                   forever while a real backlog came and went between reads.
 *   - `bufferedBytes` -- the socket's own `bufferedAmount`, bytes the browser has
 *                   accepted from us but not yet flushed to the network. Non-zero
 *                   here means WE are the slow end, which is a different failure
 *                   from a deep inbound backlog and deserves a different number.
 */

import { WS_PING, type WsPingMessage } from '@shared/ws-probe'
import { useEffect, useSyncExternalStore } from 'react'
import { wsSend } from './use-conversations'

/** How often a held probe pings. Low enough to be free, fast enough that the
 *  window refills within a minute of opening the wall. */
const PROBE_INTERVAL_MS = 5_000
/** A ping with no answer by this age never happened. Dropped, never counted as
 *  a slow round trip -- an unanswered probe is a missing sample, not a big one. */
const PROBE_TIMEOUT_MS = 15_000
/** Samples older than this leave the median. One minute of history. */
const WINDOW_MS = 60_000
/** Hard cap on retained samples, so a future faster cadence cannot grow the ring. */
const SAMPLE_CAP = 12

/** What the tile reads. */
export interface WsRttReading {
  /** Median round trip in ms over the window. `null` = no sample yet -> DASH. */
  medianMs: number | null
  /** How many samples that median was taken over. 0 while dashing. */
  samples: number
  /** Deepest rAF flush backlog observed since the previous tick. */
  queued: number
  /** Socket `bufferedAmount` at the last tick, in bytes. */
  bufferedBytes: number
}

interface Sample {
  rtt: number
  at: number
}

const EMPTY: WsRttReading = { medianMs: null, samples: 0, queued: 0, bufferedBytes: 0 }

const samples: Sample[] = []
/** token -> send time. Cleared on answer, on timeout, and on socket drop. */
const pending = new Map<string, number>()
let tokenSeq = 0
let peakQueued = 0
let reading: WsRttReading = EMPTY

let holders = 0
let timer: ReturnType<typeof setInterval> | null = null

/** Pull for the socket's `bufferedAmount`. Registered by `use-websocket.ts`,
 *  which owns the live socket; null whenever there isn't one. */
let socketDepthProbe: (() => number | null) | null = null

const listeners = new Set<() => void>()

function now(): number {
  return performance.now()
}

/** Median of the retained samples, rounded to whole ms. */
function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  const raw = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2
  return Math.round(raw)
}

/** Drop samples that aged out of the window, then anything past the cap. */
function prune(at: number): void {
  const cutoff = at - WINDOW_MS
  while (samples.length > 0 && samples[0].at < cutoff) samples.shift()
  while (samples.length > SAMPLE_CAP) samples.shift()
}

/**
 * Recompute the reading and notify ONLY if a number actually moved. The snapshot
 * identity has to be stable between real changes or `useSyncExternalStore` spins
 * (React #185 territory), and a 5-second probe has no business re-rendering a
 * pane when nothing about it changed.
 */
function publish(bufferedBytes = reading.bufferedBytes, queued = reading.queued): void {
  const next: WsRttReading = {
    medianMs: median(samples.map(s => s.rtt)),
    samples: samples.length,
    queued,
    bufferedBytes,
  }
  if (
    next.medianMs === reading.medianMs &&
    next.samples === reading.samples &&
    next.queued === reading.queued &&
    next.bufferedBytes === reading.bufferedBytes
  ) {
    return
  }
  reading = next
  for (const fn of listeners) fn()
}

/** One probe round: expire, prune, publish what we know, then ask again. */
function tick(): void {
  const at = now()

  for (const [token, sentAt] of pending) {
    if (at - sentAt > PROBE_TIMEOUT_MS) pending.delete(token)
  }
  prune(at)

  const buffered = socketDepthProbe?.() ?? 0
  publish(buffered, peakQueued)
  peakQueued = 0

  // A hidden tab is not reading the tile and its timers are throttled anyway --
  // probing from one would measure the throttle, not the network. Same rule the
  // periodic sync_check in use-websocket.ts already follows.
  if (typeof document !== 'undefined' && document.hidden) return

  const ping: WsPingMessage = { type: WS_PING, token: `rtt-${++tokenSeq}` }
  // `wsSend` returns false when there is no OPEN socket. No socket, no pending
  // entry: an un-sent ping must never age into a recorded timeout.
  if (wsSend(ping.type, { token: ping.token })) pending.set(ping.token, at)
}

/**
 * A `ws_pong` came back. Unknown tokens (a probe from before a reset, a duplicate
 * echo) are dropped in silence -- the pending map is the only thing that decides
 * what counts.
 */
export function recordPong(token: unknown): void {
  if (typeof token !== 'string') return
  const sentAt = pending.get(token)
  if (sentAt === undefined) return
  pending.delete(token)

  const at = now()
  const rtt = at - sentAt
  if (!Number.isFinite(rtt) || rtt < 0) return

  samples.push({ rtt, at })
  prune(at)
  // Publish immediately rather than at the next tick: the FIRST pong is what
  // takes the dash off the tile, and making the user wait another 5 s for a
  // number we already have would be theatre.
  publish()
}

/**
 * The rAF flush backlog, reported by `use-websocket.ts` once per flush with the
 * batch size it is about to drain. Kept as a high-water mark until the next tick
 * reads and clears it.
 */
export function recordFlushDepth(depth: number): void {
  if (depth > peakQueued) peakQueued = depth
}

/** Register (or clear, with `null`) the pull for the live socket's `bufferedAmount`. */
export function setSocketDepthProbe(fn: (() => number | null) | null): void {
  socketDepthProbe = fn
}

/**
 * The socket dropped. Every in-flight probe is unanswerable and every sample
 * describes a connection that no longer exists, so the tile goes back to a dash
 * instead of showing a latency for a wire that is down. This is the whole reason
 * the store keeps `medianMs: null` as a first-class state rather than 0.
 */
export function resetWsRtt(): void {
  samples.length = 0
  pending.clear()
  peakQueued = 0
  publish(0, 0)
}

/** Hold the probe. Refcounted: the Nth holder costs nothing, the interval runs once. */
export function acquireRttProbe(): void {
  holders++
  if (holders > 1) return
  // A number from a previous visit is not a measurement of this one.
  resetWsRtt()
  tick()
  timer = setInterval(tick, PROBE_INTERVAL_MS)
}

/** Release the probe. The last release stops the interval and clears the window. */
export function releaseRttProbe(): void {
  if (holders <= 0) return
  holders--
  if (holders > 0) return
  if (timer) clearInterval(timer)
  timer = null
  resetWsRtt()
}

/** Is the interval running right now? The "no wall open, no traffic" assertion. */
export function rttProbeRunning(): boolean {
  return timer !== null
}

/** Drop all accounting AND the interval, without going through the refcount.
 *  For test isolation only, mirroring `resetWallSubscription()`. */
export function resetRttProbeForTest(): void {
  holders = 0
  if (timer) clearInterval(timer)
  timer = null
  tokenSeq = 0
  socketDepthProbe = null
  reading = EMPTY
  samples.length = 0
  pending.clear()
  peakQueued = 0
}

export function getWsRtt(): WsRttReading {
  return reading
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => {
    listeners.delete(fn)
  }
}

/**
 * Read the round trip AND hold the probe for as long as the component is mounted.
 * The gate the card asks for lives here: only a mounted consumer keeps the probe
 * alive, which is strictly tighter than "a wall is open" -- closing the wall
 * unmounts the tile with it.
 */
export function useWsRtt(): WsRttReading {
  useEffect(() => {
    acquireRttProbe()
    return () => releaseRttProbe()
  }, [])
  return useSyncExternalStore(subscribe, getWsRtt, getWsRtt)
}
