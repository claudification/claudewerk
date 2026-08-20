/**
 * The ONE hook THE WALL and every pane inside it read from.
 *
 * Mount acquires the `wall` subscription, unmount releases it -- refcounted, so
 * ten panes still mean one `channel_subscribe` on the wire and the broker stops
 * emitting the moment the last one unmounts. There is no poll here, no
 * interval, and no per-pane fetch: if a pane needs live fleet data it reads
 * this hook's view and nothing else.
 */

import { useEffect, useSyncExternalStore } from 'react'
import { wsSend } from './use-conversations'
import { getWallView, subscribe as subscribeWallStore, type WallView } from './wall-frame-store'
import { subscribeWall, unsubscribeWall, type WallSender } from './wall-subscription'

/** The live socket send, shaped for the subscription seam. */
const send: WallSender = msg => {
  const { type, ...rest } = msg as { type: string } & Record<string, unknown>
  wsSend(type, rest)
}

/**
 * Hold the wall feed for as long as this component is mounted. Returns the
 * current fleet picture; re-renders once per applied frame (~2 Hz), never per
 * source event.
 */
export function useWallChannel(): WallView {
  useEffect(() => {
    subscribeWall(send)
    return () => unsubscribeWall(send)
  }, [])
  return useSyncExternalStore(subscribeWallStore, getWallView, getWallView)
}

// THERE IS NO READ-WITHOUT-SUBSCRIBING HOOK. There was one (`useWallView`),
// written for an ambient preview tile that shipped without ever calling it, so
// it sat here exported and unread. It is two lines -- the `useSyncExternalStore`
// call above, minus the effect -- so a surface that genuinely wants the last
// frame without keeping the broker awake should add it back TOGETHER WITH its
// consumer, rather than find this one and inherit an untested seam.
