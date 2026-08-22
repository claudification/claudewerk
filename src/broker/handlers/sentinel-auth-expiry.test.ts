import { beforeEach, describe, expect, it } from 'bun:test'
import { DAY_MS } from '../../shared/auth-expiry'
import type { ProfileUsageSnapshot } from '../../shared/protocol'
import type { HandlerContext } from '../handler-context'
import { AUTH_EXPIRY_NOTIFY_WINDOW_MS, notifyAuthExpiring, resetAuthExpiryState } from './sentinel-auth-expiry'

const NOW = 1_716_240_000_000

function snap(profile: string, authExpiresAt?: number): ProfileUsageSnapshot {
  return { profile, authed: true, polledAt: NOW, authExpiresAt }
}

interface Recorder {
  ctx: HandlerContext
  broadcasts: Record<string, unknown>[]
  pushes: { title: string; body: string; tag?: string }[]
}

function makeCtx(sentinelId: string | undefined, pushConfigured = true): Recorder {
  const broadcasts: Record<string, unknown>[] = []
  const pushes: { title: string; body: string; tag?: string }[] = []
  const ctx = {
    ws: { data: { sentinelId } },
    broadcast: (msg: Record<string, unknown>) => broadcasts.push(msg),
    log: { info() {}, error() {}, debug() {} },
    push: {
      configured: pushConfigured,
      sendToAll: (p: { title: string; body: string; tag?: string }) => pushes.push(p),
    },
  } as unknown as HandlerContext
  return { ctx, broadcasts, pushes }
}

describe('notifyAuthExpiring', () => {
  beforeEach(resetAuthExpiryState)

  it('stays silent for a login that is weeks away', () => {
    const r = makeCtx('snt_a')
    notifyAuthExpiring(r.ctx, [snap('work', NOW + 27 * DAY_MS)], NOW)
    expect(r.broadcasts).toHaveLength(0)
    expect(r.pushes).toHaveLength(0)
  })

  it('stays silent for a profile reporting no deadline at all', () => {
    const r = makeCtx('snt_a')
    notifyAuthExpiring(r.ctx, [snap('work', undefined)], NOW)
    expect(r.broadcasts).toHaveLength(0)
  })

  it('broadcasts + pushes once inside the horizon, then suppresses the rest of the day', () => {
    const r = makeCtx('snt_a')
    const profiles = [snap('work', NOW + 2 * DAY_MS)]

    notifyAuthExpiring(r.ctx, profiles, NOW)
    expect(r.broadcasts).toHaveLength(1)
    expect(r.broadcasts[0]).toMatchObject({
      type: 'profile_auth_expiring',
      sentinelId: 'snt_a',
      profile: 'work',
      expiresAt: NOW + 2 * DAY_MS,
      daysLeft: 2,
    })
    expect(r.pushes[0].tag).toBe('auth-expiry-snt_a:work')
    expect(r.pushes[0].body).toContain('expires in 2 days')

    // Poll cycles keep arriving all day; the operator hears about it once.
    notifyAuthExpiring(r.ctx, profiles, NOW + 60_000)
    notifyAuthExpiring(r.ctx, profiles, NOW + 6 * 60 * 60_000)
    expect(r.broadcasts).toHaveLength(1)
    expect(r.pushes).toHaveLength(1)
  })

  it('speaks again once the window has elapsed', () => {
    const r = makeCtx('snt_a')
    const profiles = [snap('work', NOW + 2 * DAY_MS)]
    notifyAuthExpiring(r.ctx, profiles, NOW)
    notifyAuthExpiring(r.ctx, profiles, NOW + AUTH_EXPIRY_NOTIFY_WINDOW_MS + 1)
    expect(r.broadcasts).toHaveLength(2)
  })

  it('re-arms when a /login moves the deadline, instead of inheriting its silence', () => {
    const r = makeCtx('snt_a')
    notifyAuthExpiring(r.ctx, [snap('work', NOW + 2 * DAY_MS)], NOW)
    expect(r.broadcasts).toHaveLength(1)

    // Renewed to 60 days out -- nothing to say, but the debounce is now clear.
    notifyAuthExpiring(r.ctx, [snap('work', NOW + 60 * DAY_MS)], NOW + 60_000)
    expect(r.broadcasts).toHaveLength(1)

    // A DIFFERENT deadline back inside the horizon must be announced at once,
    // even though the previous notice was minutes ago.
    notifyAuthExpiring(r.ctx, [snap('work', NOW + DAY_MS)], NOW + 120_000)
    expect(r.broadcasts).toHaveLength(2)
    expect(r.broadcasts[1]).toMatchObject({ daysLeft: 1 })
  })

  it('warns about an already-lapsed login in the past tense', () => {
    const r = makeCtx('snt_a')
    notifyAuthExpiring(r.ctx, [snap('work', NOW - DAY_MS)], NOW)
    expect(r.broadcasts[0]).toMatchObject({ daysLeft: 0 })
    expect(r.pushes[0].body).toContain('has expired')
  })

  it('keys the debounce per sentinel AND per profile', () => {
    const r = makeCtx('snt_a')
    notifyAuthExpiring(r.ctx, [snap('work', NOW + DAY_MS), snap('home', NOW + DAY_MS)], NOW)
    expect(r.broadcasts).toHaveLength(2)

    // Same profile NAME on a second host is a different login entirely.
    const other = makeCtx('snt_b')
    notifyAuthExpiring(other.ctx, [snap('work', NOW + DAY_MS)], NOW)
    expect(other.broadcasts).toHaveLength(1)
  })

  it('does nothing when the socket is not an identified sentinel', () => {
    const r = makeCtx(undefined)
    notifyAuthExpiring(r.ctx, [snap('work', NOW + DAY_MS)], NOW)
    expect(r.broadcasts).toHaveLength(0)
  })

  it('still broadcasts when push is not configured', () => {
    const r = makeCtx('snt_a', false)
    notifyAuthExpiring(r.ctx, [snap('work', NOW + DAY_MS)], NOW)
    expect(r.broadcasts).toHaveLength(1)
    expect(r.pushes).toHaveLength(0)
  })
})
