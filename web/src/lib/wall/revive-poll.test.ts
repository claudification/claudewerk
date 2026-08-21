/**
 * THE POLL CLOCK IS RE-ARMABLE, AND RE-ARMING IT PULLS NOTHING.
 *
 * `setFeedPoll` was `ensureFeedPoll` and it bailed on `if (rec.timer) return`,
 * which meant a feed polled forever at whatever rate it happened to mount with.
 * A2's window selector needs the opposite -- a clock that scales with the window
 * -- and the reason that could not simply be handed to the old function is the
 * trap `wall-stats-hourly-payload-at-long-windows` was written about: an interval
 * that changes must not cost a fetch, or every period click pays for two.
 *
 * Four claims:
 *  1. a new rate re-arms, and the OLD timer is gone (not two timers racing);
 *  2. the same rate is a no-op, and specifically does not restart the countdown
 *     -- ten sibling panes on one feed must not be able to starve its poll;
 *  3. re-arming never calls `reload`;
 *  4. the clock still stops at zero holders, and comes back on a re-acquire.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  acquireFeed,
  feedPollMs,
  feedPulls,
  releaseFeed,
  resetWallRevive,
  setFeedPoll,
  type WallFeedId,
} from './revive-store'

const FEED: WallFeedId = 'burn'
const seq = () => 1

let reload: ReturnType<typeof vi.fn>

beforeEach(() => {
  vi.useFakeTimers()
  resetWallRevive()
  reload = vi.fn(async () => true)
})

afterEach(() => {
  resetWallRevive()
  vi.useRealTimers()
})

/** Hold the feed the way a mounted pane does, without pulling. */
function hold(everyMs: number): void {
  acquireFeed(FEED, reload)
  setFeedPoll(FEED, everyMs, seq)
}

describe('setFeedPoll', () => {
  it('re-arms at a new rate and leaves no second timer behind', async () => {
    hold(60_000)
    setFeedPoll(FEED, 300_000, seq)
    expect(feedPollMs(FEED)).toBe(300_000)

    // The 60s clock is GONE: four minutes buys nothing at the five-minute rate.
    await vi.advanceTimersByTimeAsync(240_000)
    expect(reload).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('is a no-op at an unchanged rate -- it does not restart the countdown', async () => {
    hold(60_000)
    await vi.advanceTimersByTimeAsync(50_000)
    // Nine more panes mount on the same feed and all ask for the same clock.
    for (let i = 0; i < 9; i++) setFeedPoll(FEED, 60_000, seq)
    await vi.advanceTimersByTimeAsync(10_000)
    // Restarting on each call would have pushed the tick out to 140s.
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('never pulls just because the rate changed', async () => {
    hold(60_000)
    const before = feedPulls(FEED)
    setFeedPoll(FEED, 1_800_000, seq)
    setFeedPoll(FEED, 60_000, seq)
    setFeedPoll(FEED, 420_000, seq)
    await Promise.resolve()
    expect(feedPulls(FEED)).toBe(before)
    expect(reload).not.toHaveBeenCalled()
  })

  it('stops at zero holders and comes back on a re-acquire', async () => {
    hold(60_000)
    releaseFeed(FEED)
    expect(feedPollMs(FEED)).toBeNull()
    await vi.advanceTimersByTimeAsync(300_000)
    expect(reload).not.toHaveBeenCalled()

    hold(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('takes `undefined` as "this feed has no clock"', async () => {
    hold(60_000)
    setFeedPoll(FEED, undefined, seq)
    expect(feedPollMs(FEED)).toBeNull()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reload).not.toHaveBeenCalled()
  })
})
