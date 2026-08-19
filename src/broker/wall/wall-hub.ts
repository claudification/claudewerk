/**
 * THE WALL hub: the ONE fan-in point and the ~2 Hz flush.
 *
 * ZERO WORK WHEN NOBODY IS WATCHING. The flush timer is created on the 0->1
 * subscriber transition and destroyed on 1->0, and every `note*` publish seam
 * returns immediately while the subscriber set is empty. A broker with no wall
 * open does not accumulate, does not serialize and does not tick.
 *
 * Backpressure policy lives next door in wall-deliver.ts; this file owns WHO is
 * watching and WHEN a frame is built, not what happens to the bytes.
 *
 * LOG EVERYTHING: subscribe, unsubscribe (with reason), and every drop (with
 * the socket, the byte count and why) are logged with counts.
 */

import type { WallFleetCounters } from '../../shared/wall'
import { WALL_FRAME_INTERVAL_MS } from '../../shared/wall'
import { createDeliverer, type WallSocket } from './wall-deliver'
import { deltaToFrame, type ProjectFilter, snapshotToFrame } from './wall-frame'
import { createWallState, type WallState } from './wall-state'

export type { WallSocket }

export type UnsubscribeReason = 'client' | 'closed' | 'send-failed'

export interface WallHubDeps {
  /** Which projects may this socket see? Return undefined for "all of them"
   *  (an internal/trusted connection with no grants). */
  projectFilter?: (ws: WallSocket) => ProjectFilter
  /** Short label for logs (subscriber id / user name). */
  label?: (ws: WallSocket) => string
  now?: () => number
  intervalMs?: number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  log?: { info(msg: string): void; warn(msg: string): void }
  /** Fired on the 0->1 transition, BEFORE the first snapshot is built. The wall
   *  accumulates nothing while idle, so this is where the wiring seeds the
   *  current fleet picture -- otherwise the first subscriber would see an empty
   *  wall until something happened to change. */
  onFirstSubscriber?: () => void
  /** Fired on the 1->0 transition, after the timer is stopped. */
  onLastSubscriber?: () => void
}

interface Entry {
  seq: number
  frames: number
  drops: number
  subscribedAt: number
  /** Serialized last fleet counters SENT to this socket. Counters are summed
   *  over the projects this subscriber may read, so a change somewhere it
   *  cannot see must not produce a frame repeating numbers it already has. */
  lastFleet: string
}

export interface WallHub {
  state: WallState
  subscribe: (ws: WallSocket) => void
  unsubscribe: (ws: WallSocket, reason?: UnsubscribeReason) => void
  has: (ws: WallSocket) => boolean
  subscriberCount: () => number
  /** Flush now. Called by the timer; exposed so tests drive it directly. */
  tick: () => void
  /** Test isolation: drop every subscriber and clear state without logging. */
  reset: () => void
}

export function createWallHub(deps: WallHubDeps = {}): WallHub {
  const now = deps.now ?? Date.now
  const intervalMs = deps.intervalMs ?? WALL_FRAME_INTERVAL_MS
  const setTimer = deps.setTimer ?? ((fn, ms) => setInterval(fn, ms))
  const clearTimer = deps.clearTimer ?? (h => clearInterval(h as ReturnType<typeof setInterval>))
  const log = deps.log ?? { info: (m: string) => console.log(m), warn: (m: string) => console.warn(m) }
  const labelOf = deps.label ?? (() => 'ws')
  const filterOf = deps.projectFilter ?? (() => undefined)

  const state = createWallState()
  const subscribers = new Map<WallSocket, Entry>()
  let timer: unknown = null

  function startTimer(): void {
    if (timer !== null) return
    timer = setTimer(tick, intervalMs)
  }

  function stopTimer(): void {
    if (timer === null) return
    clearTimer(timer)
    timer = null
    // Nobody is watching: drop the whole fan-in picture. Nothing publishes into
    // an unwatched hub, so holding it would only let it rot -- the next
    // subscriber re-seeds a fresh one via onFirstSubscriber.
    state.reset()
  }

  const sendFrame = createDeliverer({ label: labelOf, log })

  /** Send one frame, accounting for what the delivery policy decided. A socket
   *  that threw loses its seat here rather than inside the deliverer, which
   *  knows about bytes and nothing about subscriptions. */
  function deliver(ws: WallSocket, entry: Entry, frame: Parameters<typeof sendFrame>[1]): void {
    const result = sendFrame(ws, frame, entry.drops)
    if (result === 'sent') entry.frames++
    else if (result === 'dropped') entry.drops++
    else unsubscribe(ws, 'send-failed')
  }

  function subscribe(ws: WallSocket): void {
    if (subscribers.has(ws)) {
      log.info(`[wall] +sub ${labelOf(ws)} already subscribed -- idempotent, subs=${subscribers.size}`)
      return
    }
    const entry: Entry = { seq: 0, frames: 0, drops: 0, subscribedAt: now(), lastFleet: '' }
    const first = subscribers.size === 0
    subscribers.set(ws, entry)
    startTimer()
    if (first) {
      deps.onFirstSubscriber?.()
      // The seed is the snapshot, not a delta -- drop what it marked dirty so
      // the very next tick doesn't re-send the whole fleet a second time.
      state.drain()
    }
    const snap = state.snapshot()
    entry.seq++
    const frame = snapshotToFrame(snap, state, filterOf(ws), entry.seq, now())
    entry.lastFleet = JSON.stringify(frame.fleet)
    deliver(ws, entry, frame)
    log.info(
      `[wall] +sub ${labelOf(ws)} subs=${subscribers.size} snapshot pulse=${snap.pulse.length} commits=${snap.commits.length} cards=${snap.cards.length} hosts=${snap.hosts.length} plan=${snap.plan.length}`,
    )
  }

  function unsubscribe(ws: WallSocket, reason: UnsubscribeReason = 'client'): void {
    const entry = subscribers.get(ws)
    if (!entry) return
    subscribers.delete(ws)
    log.info(
      `[wall] -sub ${labelOf(ws)} reason=${reason} subs=${subscribers.size} frames=${entry.frames} drops=${entry.drops} heldMs=${now() - entry.subscribedAt}`,
    )
    if (subscribers.size === 0) {
      stopTimer()
      deps.onLastSubscriber?.()
      log.info('[wall] no subscribers -- flush timer stopped, fan-in idle')
    }
  }

  function tick(): void {
    if (subscribers.size === 0 || !state.isDirty()) return
    const delta = state.drain()
    const at = now()
    for (const [ws, entry] of [...subscribers]) {
      const allowed = filterOf(ws)
      let fleet: WallFleetCounters | undefined
      let fleetJson = ''
      if (delta.fleetDirty) {
        const counters = state.countersFor(allowed)
        fleetJson = JSON.stringify(counters)
        if (fleetJson !== entry.lastFleet) fleet = counters
      }
      const frame = deltaToFrame(delta, allowed, entry.seq + 1, at, fleet)
      if (!frame) continue
      entry.seq++
      if (fleet) entry.lastFleet = fleetJson
      deliver(ws, entry, frame)
    }
  }

  function reset(): void {
    if (timer !== null) {
      clearTimer(timer)
      timer = null
    }
    subscribers.clear()
    state.reset()
  }

  return {
    state,
    subscribe,
    unsubscribe,
    has: ws => subscribers.has(ws),
    subscriberCount: () => subscribers.size,
    tick,
    reset,
  }
}
