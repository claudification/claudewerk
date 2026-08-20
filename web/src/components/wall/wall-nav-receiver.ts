/**
 * THE RECEIVING HALF. Without this file every cross-window click on THE WALL is
 * a dead click.
 *
 * `navigateFromWall` has been able to post a `WALL_NAV_MESSAGE` to the opener,
 * and to broadcast one when the opener reference is gone, since A8 landed the
 * sending half. Nothing anywhere listened for either. That is not a degraded
 * experience -- it is a click that does nothing, silently, which is
 * indistinguishable from a broken build and is the exact failure W4 exists to
 * prevent.
 *
 * MOUNTED IN THE MAIN WINDOW, ONCE (`app.tsx`). It refuses to arm inside the
 * detached wall popup: the popup is the SENDER, and a receiver there would let a
 * broadcast the wall itself sent loop back and open the dashboard inside the
 * wall window.
 *
 * EVERY MESSAGE IS UNTRUSTED. `postMessage` reaches any window with a handle on
 * this one, so the origin is checked and the payload is shape-checked before it
 * can reach a store action. A same-origin `BroadcastChannel` cannot be posted to
 * from another origin, but it goes through the same guard rather than a second,
 * looser one.
 */

import { useEffect } from 'react'
import { applyWallIntent, WALL_NAV_MESSAGE, type WallNavIntent } from './wall-navigate'
import { WALL_MODAL } from './wall-state'

interface WallNavEnvelope {
  type: typeof WALL_NAV_MESSAGE
  intent: WallNavIntent
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

/** Structural check on one intent. Exported so the guard itself is testable --
 *  a validator nobody tests is a validator that quietly accepts everything. */
export function isWallNavIntent(value: unknown): value is WallNavIntent {
  if (!value || typeof value !== 'object') return false
  const intent = value as Record<string, unknown>
  if (intent.kind === 'epic' || intent.kind === 'card') return isString(intent.project) && isString(intent.id)
  if (intent.kind === 'conversation') return isString(intent.id)
  if (intent.kind === 'commit') return isString(intent.hash)
  return false
}

/** The envelope both transports carry. */
function readEnvelope(data: unknown): WallNavEnvelope | null {
  if (!data || typeof data !== 'object') return null
  const envelope = data as Record<string, unknown>
  if (envelope.type !== WALL_NAV_MESSAGE) return null
  return isWallNavIntent(envelope.intent) ? { type: WALL_NAV_MESSAGE, intent: envelope.intent } : null
}

/**
 * Open what the wall asked for, and RAISE THIS WINDOW.
 *
 * The raise is half the promise: the wall is detached over the dashboard, so
 * opening a conversation behind a popup you are still looking at would read as
 * nothing having happened. Exported so a test can drive the apply without
 * faking two windows.
 */
export function receiveWallNav(data: unknown): boolean {
  const envelope = readEnvelope(data)
  if (!envelope) return false
  applyWallIntent(envelope.intent)
  try {
    window.focus()
  } catch {}
  return true
}

/** True when THIS context is the detached wall popup -- which must not listen. */
function inDetachedWallContext(): boolean {
  return typeof window !== 'undefined' && window.name === WALL_MODAL.id
}

/**
 * Listen for wall navigation intents on both transports, for as long as the
 * dashboard is mounted.
 */
export function useWallNavReceiver(): void {
  useEffect(() => {
    if (inDetachedWallContext()) return

    const onMessage = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return
      receiveWallNav(event.data)
    }
    window.addEventListener('message', onMessage)

    // `BroadcastChannel` is missing in some older WebViews, and a wall that
    // cannot fall back is still better than a dashboard that fails to boot.
    let channel: BroadcastChannel | null = null
    if (typeof BroadcastChannel !== 'undefined') {
      channel = new BroadcastChannel(WALL_NAV_MESSAGE)
      channel.onmessage = event => receiveWallNav(event.data)
    }

    return () => {
      window.removeEventListener('message', onMessage)
      channel?.close()
    }
  }, [])
}
