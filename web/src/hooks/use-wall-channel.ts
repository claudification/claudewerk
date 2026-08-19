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

/** Read the picture WITHOUT holding the subscription. For a surface that wants
 *  to render whatever last arrived (a preview tile) without keeping the broker
 *  awake on its own. */
// The preview-tile reader. Its consumer is the ambient wall tile, which no
// landed pane renders yet.
// fallow-ignore-next-line unused-export
export function useWallView(): WallView {
  return useSyncExternalStore(subscribeWallStore, getWallView, getWallView)
}
