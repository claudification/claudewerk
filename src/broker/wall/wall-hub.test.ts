import { describe, expect, it } from 'bun:test'
import { type CardMove, WALL_FRAME_INTERVAL_MS, type WallFrame, type WallPulseRow } from '../../shared/wall'
import { createWallHub, type WallHubDeps, type WallSocket } from './wall-hub'

const SILENT = { info: () => {}, warn: () => {} }

/** A socket that records what it was sent and can refuse on demand. */
function fakeSocket(opts: { refuse?: boolean; buffered?: number; throwOnSend?: boolean } = {}) {
  const frames: WallFrame[] = []
  const ws = {
    refuse: opts.refuse ?? false,
    buffered: opts.buffered ?? 0,
    frames,
    send(json: string) {
      if (opts.throwOnSend) throw new Error('socket is gone')
      if (ws.refuse) return -1
      frames.push(JSON.parse(json) as WallFrame)
      return json.length
    },
    getBufferedAmount() {
      return ws.buffered
    },
  }
  return ws
}

/** A hub whose flush timer is driven by hand, so a test never waits 500 ms. */
function testHub(over: Partial<WallHubDeps> = {}) {
  let ticking: (() => void) | null = null
  let clock = 1_000
  const hub = createWallHub({
    log: SILENT,
    now: () => clock,
    setTimer: fn => {
      ticking = fn
      return 'handle'
    },
    clearTimer: () => {
      ticking = null
    },
    ...over,
  })
  return {
    hub,
    /** Fire the interval exactly the way the runtime would. */
    fire: () => ticking?.(),
    timerRunning: () => ticking !== null,
    advance: (ms: number) => {
      clock += ms
    },
  }
}

function row(id: string, over: Partial<WallPulseRow> = {}): WallPulseRow {
  return { id, project: 'claude://default/p', title: id, status: 'active', lastActivity: 1, ...over }
}

describe('wall hub: subscription lifecycle', () => {
  it('sends a full snapshot the instant a subscriber arrives', () => {
    const { hub } = testHub({ onFirstSubscriber: () => {} })
    const ws = fakeSocket()
    hub.state.notePulse(row('a'))
    hub.subscribe(ws)

    expect(ws.frames).toHaveLength(1)
    expect(ws.frames[0]?.full).toBe(true)
    expect(ws.frames[0]?.seq).toBe(1)
  })

  it('seeds the first snapshot from the fleet, since nothing accumulates while idle', () => {
    const { hub } = testHub({
      onFirstSubscriber: () => {
        hub.state.notePulse(row('seeded'))
      },
    })
    const ws = fakeSocket()
    hub.subscribe(ws)

    expect(ws.frames[0]?.pulse?.changed.map(r => r.id)).toEqual(['seeded'])
  })

  it('the seed does not come back a second time as a delta', () => {
    const { hub, fire } = testHub({
      onFirstSubscriber: () => {
        hub.state.notePulse(row('seeded'))
      },
    })
    const ws = fakeSocket()
    hub.subscribe(ws)
    fire()

    expect(ws.frames).toHaveLength(1)
  })

  it('runs NO timer until someone subscribes, and stops it on the last unsubscribe', () => {
    const { hub, timerRunning } = testHub()
    expect(timerRunning()).toBe(false)

    const a = fakeSocket()
    const b = fakeSocket()
    hub.subscribe(a)
    expect(timerRunning()).toBe(true)
    hub.subscribe(b)

    hub.unsubscribe(a)
    expect(timerRunning()).toBe(true)
    hub.unsubscribe(b)
    expect(timerRunning()).toBe(false)
  })

  it('stops emitting to an unsubscribed socket', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)
    const afterSnapshot = ws.frames.length

    hub.unsubscribe(ws)
    hub.state.notePulse(row('a'))
    fire()

    expect(ws.frames).toHaveLength(afterSnapshot)
    expect(hub.subscriberCount()).toBe(0)
  })

  it('is idempotent: subscribing twice holds one seat, not two', () => {
    const { hub } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)
    hub.subscribe(ws)
    expect(hub.subscriberCount()).toBe(1)
    expect(ws.frames).toHaveLength(1)
  })

  it('a reconnect resubscribe gets a fresh full snapshot, not a delta', () => {
    const { hub } = testHub({
      onFirstSubscriber: () => {
        hub.state.notePulse(row('a'))
      },
    })
    const first = fakeSocket()
    hub.subscribe(first)
    hub.unsubscribe(first, 'closed')

    const reconnected = fakeSocket()
    hub.subscribe(reconnected)
    expect(reconnected.frames[0]?.full).toBe(true)
    expect(reconnected.frames[0]?.pulse?.changed.map(r => r.id)).toEqual(['a'])
  })
})

describe('wall hub: coalescing', () => {
  it('one frame per tick no matter how many events landed in the window', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)

    for (let i = 0; i < 40; i++) hub.state.notePulse(row('a', { lastActivity: i }))
    fire()

    const delta = ws.frames.at(-1)
    expect(ws.frames).toHaveLength(2) // snapshot + one delta
    expect(delta?.pulse?.changed).toHaveLength(1)
    expect(delta?.coalesced).toBe(40)
  })

  it('sends nothing on a quiet tick -- a wall_frame always means something moved', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)
    fire()
    fire()
    expect(ws.frames).toHaveLength(1)
  })

  it('holds ~2 Hz under a 100-conversation fleet churning every tick', () => {
    const fleet = Array.from({ length: 100 }, (_, i) => `c${i}`)
    const { hub, fire } = testHub({
      onFirstSubscriber: () => {
        for (const id of fleet) hub.state.notePulse(row(id))
      },
    })
    const ws = fakeSocket()
    hub.subscribe(ws)

    const WINDOWS = 10
    for (let w = 0; w < WINDOWS; w++) {
      for (const id of fleet) hub.state.notePulse(row(id, { lastActivity: w }))
      fire()
    }

    // 1000 source events -> 10 frames. Not 1000, and not one fat catch-up frame.
    expect(ws.frames).toHaveLength(1 + WINDOWS)
    for (const frame of ws.frames.slice(1)) {
      expect(frame.coalesced).toBe(100)
      expect(frame.pulse?.changed).toHaveLength(100)
    }
    expect(WALL_FRAME_INTERVAL_MS).toBe(500)
  })
})

describe('wall hub: card moves ride the same frame', () => {
  const card = (id: string, ts: number): CardMove => ({
    id,
    project: 'claude://default/p',
    title: id,
    from: 'open',
    to: 'done',
    ts,
  })

  it('serves cards NEWEST FIRST, the order a ledger is read in', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)

    // Arrival order in (one board write, several cards).
    hub.state.noteCard(card('first', 1))
    hub.state.noteCard(card('second', 2))
    fire()

    expect(ws.frames.at(-1)?.cards?.map(c => c.id)).toEqual(['second', 'first'])
  })

  it('seeds the snapshot with the ring so a cold wall has history', () => {
    const { hub } = testHub({
      onFirstSubscriber: () => {
        // The seed walks the ring oldest-first; the wire flips it back.
        hub.state.noteCard(card('older', 1))
        hub.state.noteCard(card('newer', 2))
      },
    })
    const ws = fakeSocket()
    hub.subscribe(ws)

    expect(ws.frames[0]?.full).toBe(true)
    expect(ws.frames[0]?.cards?.map(c => c.id)).toEqual(['newer', 'older'])
  })

  it('filters card moves by the subscriber’s projects like everything else', () => {
    const { hub, fire } = testHub({
      projectFilter: () => p => p === 'claude://default/mine',
    })
    const ws = fakeSocket()
    hub.subscribe(ws)

    hub.state.noteCard({ ...card('hidden', 1), project: 'claude://default/theirs' })
    hub.state.noteCard({ ...card('shown', 2), project: 'claude://default/mine' })
    fire()

    expect(ws.frames.at(-1)?.cards?.map(c => c.id)).toEqual(['shown'])
  })
})

describe('wall hub: backpressure', () => {
  it('drops the frame and keeps the socket when the send is refused', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket()
    hub.subscribe(ws)

    ws.refuse = true
    hub.state.notePulse(row('a'))
    fire()
    expect(ws.frames).toHaveLength(1)
    expect(hub.has(ws)).toBe(true)

    // Latest-wins: the next frame carries current state, nothing is replayed.
    ws.refuse = false
    hub.state.notePulse(row('a', { lastActivity: 99 }))
    fire()
    const latest = ws.frames.at(-1)
    expect(latest?.pulse?.changed[0]?.lastActivity).toBe(99)
    expect(latest?.seq).toBe(3) // seq 2 was dropped -- the gap IS the evidence
  })

  it('drops rather than piles on when the socket buffer has ballooned', () => {
    const { hub, fire } = testHub()
    const ws = fakeSocket({ buffered: 8 * 1024 * 1024 })
    hub.subscribe(ws)
    hub.state.notePulse(row('a'))
    fire()
    expect(ws.frames).toHaveLength(0)
    expect(hub.has(ws)).toBe(true)
  })

  it('drops a socket whose send throws', () => {
    const { hub } = testHub()
    const ws = fakeSocket({ throwOnSend: true })
    hub.subscribe(ws)
    expect(hub.has(ws)).toBe(false)
  })
})

describe('wall hub: permission filtering', () => {
  const mine = 'claude://default/mine'
  const theirs = 'claude://default/theirs'

  function scopedHub() {
    const allowed = new WeakMap<WallSocket, string>()
    const ctx = testHub({
      projectFilter: ws => {
        const only = allowed.get(ws)
        return only ? p => p === only : undefined
      },
    })
    return { ...ctx, allowed }
  }

  it('a scoped subscriber never sees another project, in the snapshot or the delta', () => {
    const { hub, fire, allowed } = scopedHub()
    const ws = fakeSocket()
    allowed.set(ws, mine)
    hub.state.notePulse(row('a', { project: mine }))
    hub.state.notePulse(row('b', { project: theirs }))
    hub.subscribe(ws)
    expect(ws.frames[0]?.pulse?.changed.map(r => r.id)).toEqual(['a'])

    hub.state.notePulse(row('b', { project: theirs, lastActivity: 5 }))
    fire()
    expect(ws.frames).toHaveLength(1) // nothing it may see changed -> no frame at all
  })

  it('scopes the fleet counters to the same projects', () => {
    const { hub, allowed } = scopedHub()
    const ws = fakeSocket()
    allowed.set(ws, mine)
    hub.state.notePulse(row('a', { project: mine }))
    hub.state.notePulse(row('b', { project: theirs }))
    hub.subscribe(ws)

    expect(ws.frames[0]?.fleet?.conversations).toBe(1)
  })

  it('never repeats fleet counters a subscriber already has', () => {
    const { hub, fire, allowed } = scopedHub()
    const ws = fakeSocket()
    allowed.set(ws, mine)
    hub.subscribe(ws)

    // A conversation appearing in a project this socket cannot read moves the
    // GLOBAL counters but not ITS counters -- so no frame at all.
    hub.state.notePulse(row('hidden', { project: theirs }))
    fire()
    expect(ws.frames).toHaveLength(1)

    hub.state.notePulse(row('visible', { project: mine }))
    fire()
    expect(ws.frames.at(-1)?.fleet?.conversations).toBe(1)
  })

  it('two subscribers with different scopes get different frames from one flush', () => {
    const { hub, fire, allowed } = scopedHub()
    const a = fakeSocket()
    const b = fakeSocket()
    allowed.set(a, mine)
    allowed.set(b, theirs)
    hub.subscribe(a)
    hub.subscribe(b)

    hub.state.notePulse(row('x', { project: mine }))
    fire()

    expect(a.frames.at(-1)?.pulse?.changed.map(r => r.id)).toEqual(['x'])
    expect(b.frames).toHaveLength(1) // snapshot only
  })
})
