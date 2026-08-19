import { WALL_CHANNEL } from '@shared/wall'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  resetWallSubscription,
  resubscribeWall,
  subscribeWall,
  unsubscribeWall,
  wallHolders,
} from './wall-subscription'

const SUB = { type: 'channel_subscribe', channel: WALL_CHANNEL }
const UNSUB = { type: 'channel_unsubscribe', channel: WALL_CHANNEL }

beforeEach(() => resetWallSubscription())

describe('wall subscription: ten panes, one subscription', () => {
  it('sends channel_subscribe exactly once on the 0->1 transition', () => {
    const send = vi.fn()
    for (let i = 0; i < 10; i++) subscribeWall(send)

    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(SUB)
    expect(wallHolders()).toBe(10)
  })

  it('sends channel_unsubscribe exactly once, on the LAST release', () => {
    const send = vi.fn()
    for (let i = 0; i < 3; i++) subscribeWall(send)
    send.mockClear()

    unsubscribeWall(send)
    unsubscribeWall(send)
    expect(send).not.toHaveBeenCalled()

    unsubscribeWall(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(UNSUB)
    expect(wallHolders()).toBe(0)
  })

  it('survives the ordinary React swap: one pane mounts as another unmounts', () => {
    const send = vi.fn()
    subscribeWall(send) // pane A
    send.mockClear()

    subscribeWall(send) // pane B mounts
    unsubscribeWall(send) // pane A unmounts
    // The feed never dropped, so nothing went on the wire at all.
    expect(send).not.toHaveBeenCalled()
    expect(wallHolders()).toBe(1)
  })

  it('releasing an unheld feed is a no-op, not a stray unsubscribe', () => {
    const send = vi.fn()
    unsubscribeWall(send)
    expect(send).not.toHaveBeenCalled()
    expect(wallHolders()).toBe(0)
  })
})

describe('wall subscription: reconnect', () => {
  it('re-asserts the subscription WITHOUT touching the refcount', () => {
    const send = vi.fn()
    subscribeWall(send)
    subscribeWall(send)
    send.mockClear()

    resubscribeWall(send)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith(SUB)
    // Still two holders: a resubscribe is recovery, not an acquire.
    expect(wallHolders()).toBe(2)
  })

  it('stays silent on reconnect when no pane is holding the feed', () => {
    const send = vi.fn()
    resubscribeWall(send)
    expect(send).not.toHaveBeenCalled()
  })
})
