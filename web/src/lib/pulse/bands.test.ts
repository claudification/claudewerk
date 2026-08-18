import { describe, expect, it } from 'vitest'
import type { Conversation, LiveStatus, LiveStatusState } from '@/lib/types'
import { bandOf, compareInBand, JUST_DONE_WINDOW_MS, PULSE_BANDS, wantsAttention } from './bands'

const NOW = 1_800_000_000_000

/** Minimal Conversation good enough for band assignment. The real record has
 *  ~60 fields; banding only reads the six asserted here. */
function conv(over: Partial<Conversation> = {}): Conversation {
  return {
    id: 'conv_1',
    project: 'claude:///remote-claude',
    status: 'active',
    startedAt: NOW - 60_000,
    lastActivity: NOW - 1_000,
    ...over,
  } as unknown as Conversation
}

const live = (state: LiveStatusState, over: Partial<LiveStatus> = {}): LiveStatus =>
  ({ state, seq: 1, updatedAt: NOW - 5_000, ...over }) as LiveStatus

describe('PULSE_BANDS', () => {
  it('leads with WORKING, then JUST DONE, then NEEDS YOU', () => {
    // Two reorderings, both driven by real fleet data. needs-first buried the
    // dozen things actually running under three dozen that mostly were not
    // blocked. Then working -> needs -> done pushed JUST DONE below a 30-row
    // needs band, i.e. off screen -- and a finished run is the most perishable
    // row on the board (merge it, ship it, or catch a bad landing).
    expect([...PULSE_BANDS]).toEqual(['working', 'done', 'needs', 'idle', 'expired'])
  })

  it('keeps the two perishable bands above the long queue', () => {
    const order = [...PULSE_BANDS]
    expect(order.indexOf('done')).toBeLessThan(order.indexOf('needs'))
    expect(order.indexOf('working')).toBeLessThan(order.indexOf('done'))
  })

  it('keeps expired last so it can collapse to a count', () => {
    expect(PULSE_BANDS[PULSE_BANDS.length - 1]).toBe('expired')
  })
})

describe('wantsAttention', () => {
  it('is false for a plain working conversation', () => {
    expect(wantsAttention(conv({ liveStatus: live('working') }))).toBe(false)
  })

  it('fires on pendingAttention regardless of liveStatus', () => {
    const c = conv({ pendingAttention: { type: 'permission', timestamp: NOW } })
    expect(wantsAttention(c)).toBe(true)
  })

  it('fires on each pendingAttention type', () => {
    for (const type of ['permission', 'elicitation', 'ask', 'dialog', 'plan_approval', 'spawn_approval'] as const) {
      expect(wantsAttention(conv({ pendingAttention: { type, timestamp: NOW } }))).toBe(true)
    }
  })

  it('fires on liveStatus needs_you and blocked', () => {
    expect(wantsAttention(conv({ liveStatus: live('needs_you') }))).toBe(true)
    expect(wantsAttention(conv({ liveStatus: live('blocked') }))).toBe(true)
  })

  it('does NOT fire on liveStatus done', () => {
    expect(wantsAttention(conv({ liveStatus: live('done') }))).toBe(false)
  })

  it('fires on a pending spawn approval', () => {
    const c = conv({
      pendingSpawnApproval: { requestId: 'r1', requestedAt: NOW, request: {}, reason: 'why' },
    })
    expect(wantsAttention(c)).toBe(true)
  })

  it('fires on store-held pending permission and pending link', () => {
    expect(wantsAttention(conv(), { hasPendingPermission: true })).toBe(true)
    expect(wantsAttention(conv(), { hasPendingLink: true })).toBe(true)
  })

  it('goes quiet once the user has typed since the agent raised its hand', () => {
    const c = conv({ liveStatus: live('needs_you', { updatedAt: NOW - 10_000 }), lastInputAt: NOW - 1_000 })
    expect(wantsAttention(c)).toBe(false)
  })

  it('still fires when the user typed BEFORE the agent raised its hand', () => {
    const c = conv({ liveStatus: live('needs_you', { updatedAt: NOW - 1_000 }), lastInputAt: NOW - 10_000 })
    expect(wantsAttention(c)).toBe(true)
  })

  it('ignores supersession for a broker-side pendingAttention', () => {
    // pendingAttention is the broker's own live queue, not a stale self-report.
    const c = conv({ pendingAttention: { type: 'ask', timestamp: NOW }, lastInputAt: NOW })
    expect(wantsAttention(c)).toBe(true)
  })
})

describe('bandOf', () => {
  it('puts attention above liveness — an active conversation asking a question is NEEDS', () => {
    const c = conv({ status: 'active', pendingAttention: { type: 'permission', timestamp: NOW } })
    expect(bandOf(c, {}, NOW)).toBe('needs')
  })

  it('bands live statuses as working', () => {
    for (const status of ['active', 'starting', 'booting'] as const) {
      expect(bandOf(conv({ status }), {}, NOW)).toBe('working')
    }
  })

  it('NEVER puts an ended conversation in NEEDS YOU, whatever it last claimed', () => {
    // THE BUG (2026-08-18, seen live): an agent whose final act was `needs_you`
    // parked itself at the top of NEEDS YOU forever. There is no process left
    // to answer, so the report is a fossil, not a request -- and it pushed live
    // work down the page while being unanswerable and unclearable.
    const c = conv({ status: 'ended', liveStatus: live('needs_you'), lastActivity: NOW - 60_000 })
    expect(bandOf(c, {}, NOW)).toBe('done')
  })

  it('keeps an ended conversation out of NEEDS YOU for every attention source', () => {
    for (const over of [
      { liveStatus: live('needs_you') },
      { liveStatus: live('blocked') },
      { pendingAttention: { type: 'permission' as const, timestamp: NOW } },
      { pendingSpawnApproval: { requestId: 'r', requestedAt: NOW, request: {}, reason: 'why' } },
    ]) {
      const c = conv({ status: 'ended', lastActivity: NOW - 60_000, ...over })
      expect(bandOf(c, {}, NOW)).not.toBe('needs')
    }
  })

  it('keeps an ended conversation out of NEEDS YOU even via broker-side flags', () => {
    const c = conv({ status: 'ended', lastActivity: NOW - 60_000 })
    expect(bandOf(c, { hasPendingPermission: true, hasPendingLink: true }, NOW)).not.toBe('needs')
  })

  it('expires a long-dead conversation that was still claiming needs_you', () => {
    const c = conv({
      status: 'ended',
      liveStatus: live('needs_you'),
      lastActivity: NOW - JUST_DONE_WINDOW_MS - 1,
    })
    expect(bandOf(c, {}, NOW)).toBe('expired')
  })

  it('still lets a LIVE conversation reach NEEDS YOU', () => {
    // The fix must not go so far that nothing can ask for attention.
    expect(bandOf(conv({ status: 'active', liveStatus: live('needs_you') }), {}, NOW)).toBe('needs')
  })

  it('bands a recently ended conversation as done', () => {
    const c = conv({ status: 'ended', lastActivity: NOW - 60_000 })
    expect(bandOf(c, {}, NOW)).toBe('done')
  })

  it('bands a long-ended conversation as expired', () => {
    const c = conv({ status: 'ended', lastActivity: NOW - JUST_DONE_WINDOW_MS - 1 })
    expect(bandOf(c, {}, NOW)).toBe('expired')
  })

  it('bands a fresh self-reported done as done even while idle', () => {
    const c = conv({ status: 'idle', liveStatus: live('done'), lastActivity: NOW - 60_000 })
    expect(bandOf(c, {}, NOW)).toBe('done')
  })

  it('drops a stale self-reported done to idle', () => {
    const c = conv({ status: 'idle', liveStatus: live('done'), lastActivity: NOW - JUST_DONE_WINDOW_MS - 1 })
    expect(bandOf(c, {}, NOW)).toBe('idle')
  })

  it('drops a superseded done to idle', () => {
    const c = conv({
      status: 'idle',
      liveStatus: live('done', { updatedAt: NOW - 10_000 }),
      lastInputAt: NOW - 1_000,
      lastActivity: NOW - 5_000,
    })
    expect(bandOf(c, {}, NOW)).toBe('idle')
  })

  it('bands a quiet idle conversation as idle', () => {
    expect(bandOf(conv({ status: 'idle' }), {}, NOW)).toBe('idle')
  })

  it('assigns exactly one band per conversation', () => {
    const samples = [
      conv({ status: 'active' }),
      conv({ status: 'idle' }),
      conv({ status: 'ended' }),
      conv({ pendingAttention: { type: 'ask', timestamp: NOW } }),
    ]
    for (const c of samples) expect(PULSE_BANDS).toContain(bandOf(c, {}, NOW))
  })
})

describe('compareInBand', () => {
  const older = conv({ lastActivity: NOW - 600_000 })
  const newer = conv({ lastActivity: NOW - 1_000 })

  it('sorts NEEDS oldest first — the request rotting longest is the most urgent', () => {
    expect([newer, older].sort((a, b) => compareInBand('needs', a, b))[0]).toBe(older)
  })

  it('sorts every other band freshest first', () => {
    for (const band of ['working', 'done', 'idle', 'expired'] as const) {
      expect([older, newer].sort((a, b) => compareInBand(band, a, b))[0]).toBe(newer)
    }
  })
})
