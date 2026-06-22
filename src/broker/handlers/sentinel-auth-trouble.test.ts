import { beforeEach, describe, expect, it } from 'bun:test'
import type { ProfileUsageSnapshot } from '../../shared/protocol'
import type { HandlerContext } from '../handler-context'
import { authTroubleDebouncer, classifyAuthTrouble, notifyAuthTrouble } from './sentinel'

const WINDOW = 10 * 60_000

function snap(profile: string, error?: ProfileUsageSnapshot['error']): ProfileUsageSnapshot {
  return { profile, authed: true, polledAt: 0, error }
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

describe('classifyAuthTrouble', () => {
  it('maps the auth-failure shapes', () => {
    expect(classifyAuthTrouble(snap('p'))).toBeNull()
    expect(classifyAuthTrouble(snap('p', { kind: 'no_token' }))).toBe('no_token')
    expect(classifyAuthTrouble(snap('p', { kind: 'http', status: 401 }))).toBe('http_401')
    expect(classifyAuthTrouble(snap('p', { kind: 'http', status: 403 }))).toBe('http_403')
    expect(classifyAuthTrouble(snap('p', { kind: 'network', detail: 'invalid_grant: dead' }))).toBe('invalid_grant')
  })

  it('excludes 429 rate-limit and plain network/parse blips', () => {
    expect(classifyAuthTrouble(snap('p', { kind: 'http', status: 429 }))).toBeNull()
    expect(classifyAuthTrouble(snap('p', { kind: 'network', detail: 'timeout' }))).toBeNull()
    expect(classifyAuthTrouble(snap('p', { kind: 'parse', detail: 'bad json' }))).toBeNull()
  })
})

describe('notifyAuthTrouble', () => {
  beforeEach(() => authTroubleDebouncer.reset())

  it('broadcasts + pushes once for a 401, suppresses repeats within the window', () => {
    const r = makeCtx('snt_a')
    const p401 = [snap('work', { kind: 'http', status: 401, detail: 'oauth dead' })]

    notifyAuthTrouble(r.ctx, p401, 0)
    expect(r.broadcasts).toHaveLength(1)
    expect(r.pushes).toHaveLength(1)
    expect(r.broadcasts[0]).toMatchObject({
      type: 'profile_auth_trouble',
      sentinelId: 'snt_a',
      profile: 'work',
      reason: 'http_401',
      status: 401,
    })
    expect(r.pushes[0].tag).toBe('auth-trouble-snt_a:work')

    notifyAuthTrouble(r.ctx, p401, 5 * 60_000) // within 10min window
    expect(r.pushes).toHaveLength(1)

    notifyAuthTrouble(r.ctx, p401, WINDOW + 1) // window elapsed
    expect(r.pushes).toHaveLength(2)
  })

  it('re-arms on recovery so the next failure notifies immediately', () => {
    const r = makeCtx('snt_a')
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401 })], 0)
    expect(r.pushes).toHaveLength(1)

    // Healthy poll resets the key.
    notifyAuthTrouble(r.ctx, [snap('work')], 1000)
    expect(r.pushes).toHaveLength(1)

    // Fresh failure right after recovery -> notifies again despite being in-window.
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401 })], 2000)
    expect(r.pushes).toHaveLength(2)
  })

  it('keys per sentinel:profile -- independent profiles each notify', () => {
    const r = makeCtx('snt_a')
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401 }), snap('default', { kind: 'no_token' })], 0)
    expect(r.pushes).toHaveLength(2)
    expect(r.broadcasts.map(b => b.profile).sort()).toEqual(['default', 'work'])
  })

  it('still broadcasts when push is not configured', () => {
    const r = makeCtx('snt_a', false)
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401 })], 0)
    expect(r.broadcasts).toHaveLength(1)
    expect(r.pushes).toHaveLength(0)
  })

  it('no sentinelId -> no-op (cannot key)', () => {
    const r = makeCtx(undefined)
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401 })], 0)
    expect(r.broadcasts).toHaveLength(0)
    expect(r.pushes).toHaveLength(0)
  })

  it('never leaks configDir in detail or recoveryHint', () => {
    const r = makeCtx('snt_a')
    notifyAuthTrouble(r.ctx, [snap('work', { kind: 'http', status: 401, detail: 'token expired' })], 0)
    const msg = r.broadcasts[0]
    expect(JSON.stringify(msg)).not.toContain('/Users/')
    expect(JSON.stringify(msg)).not.toContain('.claude-work')
  })
})
