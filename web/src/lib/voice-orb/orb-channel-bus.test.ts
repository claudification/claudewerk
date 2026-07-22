import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getOrbChannelQueue,
  isOrbChannelDraining,
  pushOrbChannelMessage,
  setOrbChannelDraining,
  setOrbChannelQueue,
  subscribeOrbChannel,
} from './orb-channel-bus'

function msg(body: string) {
  return { sourceConversationId: 'c', sourceName: 'arr', body, ts: 1 }
}

describe('orb-channel-bus', () => {
  beforeEach(() => setOrbChannelQueue([]))

  it('enqueues and exposes the queue', () => {
    pushOrbChannelMessage(msg('a'))
    pushOrbChannelMessage(msg('b'))
    expect(getOrbChannelQueue().map(m => m.body)).toEqual(['a', 'b'])
  })

  it('notifies the live subscriber on push', () => {
    const cb = vi.fn()
    const unsub = subscribeOrbChannel(cb)
    pushOrbChannelMessage(msg('x'))
    expect(cb).toHaveBeenCalledTimes(1)
    unsub()
    pushOrbChannelMessage(msg('y'))
    expect(cb).toHaveBeenCalledTimes(1) // no longer subscribed
  })

  it('tracks the draining flag', () => {
    expect(isOrbChannelDraining()).toBe(false)
    setOrbChannelDraining(true)
    expect(isOrbChannelDraining()).toBe(true)
    setOrbChannelDraining(false)
  })
})
