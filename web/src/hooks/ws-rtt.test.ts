/**
 * The claims P4's socket tile now makes about its latency number.
 *
 *  - it is a MEDIAN over a window, so one bad round trip cannot move it
 *  - it is a DASH until a real pong comes back -- never 0, never a guess
 *  - a dropped socket takes the number with it, rather than leaving a latency
 *    on screen for a wire that is down
 *  - nothing is on the wire while nothing is holding the probe
 */

import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'

const sent: Array<{ type: string; rest: Record<string, unknown> }> = []
let sendSucceeds = true
vi.mock('./use-conversations', () => ({
  wsSend: (type: string, rest?: Record<string, unknown>) => {
    if (!sendSucceeds) return false
    sent.push({ type, rest: rest ?? {} })
    return true
  },
}))

const {
  acquireRttProbe,
  getWsRtt,
  recordFlushDepth,
  recordPong,
  releaseRttProbe,
  resetRttProbeForTest,
  resetWsRtt,
  rttProbeRunning,
  setSocketDepthProbe,
} = await import('./ws-rtt')

const PROBE_INTERVAL_MS = 5_000

/** The store reads `performance.now()` for both the delta and the sample ages,
 *  so the test owns that clock outright instead of hoping a timer shim fakes it. */
let clock = 0
function advance(ms: number) {
  clock += ms
  vi.advanceTimersByTime(ms)
}

/** Tokens the probe has put on the wire, oldest first. */
function tokens(): string[] {
  return sent.filter(m => m.type === 'ws_ping').map(m => m.rest.token as string)
}

/** Answer the newest outstanding ping `rtt` ms after it was sent. */
function roundTrip(rtt: number) {
  const token = tokens().at(-1)
  clock += rtt
  recordPong(token)
}

beforeEach(() => {
  vi.useFakeTimers()
  clock = 0
  vi.spyOn(performance, 'now').mockImplementation(() => clock)
  sent.length = 0
  sendSucceeds = true
  resetRttProbeForTest()
})

afterEach(() => {
  resetRttProbeForTest()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('ws round-trip probe', () => {
  test('dashes until the first pong comes back', () => {
    expect(getWsRtt().medianMs).toBeNull()

    acquireRttProbe()
    // The probe fires immediately on acquire -- waiting a full interval for the
    // first sample would leave the tile dashing for 5s on every wall open.
    expect(tokens()).toHaveLength(1)
    expect(getWsRtt().medianMs).toBeNull()
    expect(getWsRtt().samples).toBe(0)

    roundTrip(23)
    expect(getWsRtt().medianMs).toBe(23)
    expect(getWsRtt().samples).toBe(1)
  })

  test('reports the MEDIAN of the window, not the last sample and not the mean', () => {
    acquireRttProbe()
    // One 500 ms outlier among four 10s. Mean = 108, last = 500, median = 10.
    for (const rtt of [10, 10, 500, 10]) {
      roundTrip(rtt)
      advance(PROBE_INTERVAL_MS)
    }
    expect(getWsRtt().samples).toBe(4)
    expect(getWsRtt().medianMs).toBe(10)
  })

  test('ages samples out of the window instead of averaging over all history', () => {
    acquireRttProbe()
    roundTrip(500)
    expect(getWsRtt().medianMs).toBe(500)

    // Past the 60s window with no new answers: the old sample is gone and the
    // tile is honest about having nothing rather than showing a stale 500.
    for (let i = 0; i < 14; i++) advance(PROBE_INTERVAL_MS)
    expect(getWsRtt().samples).toBe(0)
    expect(getWsRtt().medianMs).toBeNull()
  })

  test('a dropped socket leaves no latency on screen', () => {
    acquireRttProbe()
    roundTrip(12)
    expect(getWsRtt().medianMs).toBe(12)

    resetWsRtt()
    expect(getWsRtt().medianMs).toBeNull()
    expect(getWsRtt().samples).toBe(0)
    expect(getWsRtt().queued).toBe(0)
    expect(getWsRtt().bufferedBytes).toBe(0)
  })

  test('a pong for a probe sent before the drop is not counted after it', () => {
    acquireRttProbe()
    const stale = tokens().at(-1)
    resetWsRtt()

    clock += 9
    recordPong(stale)
    expect(getWsRtt().medianMs).toBeNull()
  })

  test('an unanswered ping expires instead of becoming a slow sample', () => {
    acquireRttProbe()
    const dropped = tokens()[0]

    // Well past PROBE_TIMEOUT_MS. The probe keeps asking; nothing answers.
    for (let i = 0; i < 4; i++) advance(PROBE_INTERVAL_MS)
    expect(tokens().length).toBeGreaterThan(1)
    expect(getWsRtt().medianMs).toBeNull()

    // A very late echo must not land as a 20-second round trip.
    recordPong(dropped)
    expect(getWsRtt().medianMs).toBeNull()
  })

  test('ignores a token it never sent', () => {
    acquireRttProbe()
    recordPong('rtt-not-ours')
    recordPong(undefined)
    expect(getWsRtt().medianMs).toBeNull()
  })

  test('registers no pending probe when there is no open socket to send on', () => {
    sendSucceeds = false
    acquireRttProbe()
    expect(tokens()).toHaveLength(0)

    // The socket comes back; the very next probe answers normally, proving the
    // un-sent one left nothing behind to confuse the match.
    sendSucceeds = true
    advance(PROBE_INTERVAL_MS)
    roundTrip(7)
    expect(getWsRtt().medianMs).toBe(7)
  })

  test('nothing is on the wire while nothing holds the probe', () => {
    expect(rttProbeRunning()).toBe(false)
    advance(PROBE_INTERVAL_MS * 3)
    expect(tokens()).toHaveLength(0)

    acquireRttProbe()
    expect(rttProbeRunning()).toBe(true)
    advance(PROBE_INTERVAL_MS * 2)
    expect(tokens()).toHaveLength(3)

    releaseRttProbe()
    expect(rttProbeRunning()).toBe(false)
    advance(PROBE_INTERVAL_MS * 5)
    expect(tokens()).toHaveLength(3)
  })

  test('two holders still mean one probe on the wire, and the last one stops it', () => {
    acquireRttProbe()
    acquireRttProbe()
    advance(PROBE_INTERVAL_MS)
    expect(tokens()).toHaveLength(2)

    releaseRttProbe()
    expect(rttProbeRunning()).toBe(true)
    releaseRttProbe()
    expect(rttProbeRunning()).toBe(false)
  })

  test('releasing the probe clears the window, so a reopened wall dashes again', () => {
    acquireRttProbe()
    roundTrip(31)
    expect(getWsRtt().medianMs).toBe(31)

    releaseRttProbe()
    acquireRttProbe()
    expect(getWsRtt().medianMs).toBeNull()
  })

  test('queue depth is the deepest flush backlog since the last tick', () => {
    setSocketDepthProbe(() => 4096)
    acquireRttProbe()

    recordFlushDepth(2)
    recordFlushDepth(9)
    recordFlushDepth(1)
    advance(PROBE_INTERVAL_MS)
    // 9, not 1 and not 12: the peak of the backlog, which is the number an
    // instantaneous read of a rAF-drained buffer could never see.
    expect(getWsRtt().queued).toBe(9)
    expect(getWsRtt().bufferedBytes).toBe(4096)

    // Quiet interval -> back to zero, rather than holding the old peak forever.
    advance(PROBE_INTERVAL_MS)
    expect(getWsRtt().queued).toBe(0)
  })

  test('reports 0 buffered bytes when no socket has registered a probe', () => {
    acquireRttProbe()
    advance(PROBE_INTERVAL_MS)
    expect(getWsRtt().bufferedBytes).toBe(0)
  })
})
