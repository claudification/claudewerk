/**
 * The orb channel's browser SINGLETON: a bounded queue that survives across
 * summons plus a single subscriber slot for the live orb.
 *
 * Why a module singleton (not React state): messages arrive on the app-level
 * WebSocket whether or not the orb is summoned, and the orb host is inside a
 * lazy chunk that may not be mounted yet. The queue must outlive any one host
 * mount so a line that arrives while the orb is away is still there to speak
 * when it is summoned. Mirrors tool-bridge.ts's `activeBridge` slot.
 *
 * This module is pure of WebRTC -- safe to import from the app WS handler
 * without pulling the heavy orb chunk into the index bundle.
 */

import { enqueue, type OrbChannelMessage } from './orb-channel'

let queue: OrbChannelMessage[] = []
let notify: (() => void) | null = null
let draining = false

/** A `voice_orb_deliver` arrived (already filtered for this instance). Enqueue
 *  and poke the live orb, if any. */
export function pushOrbChannelMessage(msg: OrbChannelMessage): void {
  queue = enqueue(queue, msg)
  notify?.()
}

export function getOrbChannelQueue(): OrbChannelMessage[] {
  return queue
}

/** Replace the queue after a drain decision (stale pruned + spoken line removed). */
export function setOrbChannelQueue(next: OrbChannelMessage[]): void {
  queue = next
}

/** The live orb subscribes while summoned; returns an unsubscribe. One orb at a
 *  time (single global surface), so one slot is enough. */
export function subscribeOrbChannel(cb: () => void): () => void {
  notify = cb
  return () => {
    if (notify === cb) notify = null
  }
}

/** True while a summoned orb is actively draining -- lets the WS handler decide
 *  whether an arriving message needs a toast (nobody is listening yet). */
export function setOrbChannelDraining(v: boolean): void {
  draining = v
}

export function isOrbChannelDraining(): boolean {
  return draining
}
