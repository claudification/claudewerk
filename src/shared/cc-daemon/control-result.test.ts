import { describe, expect, it } from 'bun:test'
import { ProtocolMismatchError } from './client'
import { controlResultFailure, controlResultFromError, controlResultFromResponse } from './control-result'
import type { DaemonResponse } from './types'

describe('controlResultFromResponse', () => {
  it('maps an ok frame to an ok result', () => {
    const r = controlResultFromResponse('conv_a', 'reply', { ok: true, op: 'reply' })
    expect(r.type).toBe('daemon_control_result')
    expect(r.conversationId).toBe('conv_a')
    expect(r.op).toBe('reply')
    expect(r.ok).toBe(true)
    expect(r.code).toBeUndefined()
    expect(typeof r.t).toBe('number')
  })

  it('passes the daemon error code straight through on an error frame', () => {
    const resp: DaemonResponse = { ok: false, error: 'worker is mid-turn', code: 'ENOREPLY' }
    const r = controlResultFromResponse('conv_b', 'reply', resp)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ENOREPLY')
    expect(r.detail).toBe('worker is mid-turn')
  })

  it('falls back to EUNKNOWN when an error frame omits a code', () => {
    const r = controlResultFromResponse('conv_c', 'kill', { ok: false, error: 'boom' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('EUNKNOWN')
    expect(r.detail).toBe('boom')
  })
})

describe('controlResultFailure', () => {
  it('builds an explicit failure with a caller-chosen code', () => {
    const r = controlResultFailure('conv_d', 'respawn_stale', 'EHOSTGONE', 'host not connected')
    expect(r.ok).toBe(false)
    expect(r.op).toBe('respawn_stale')
    expect(r.code).toBe('EHOSTGONE')
    expect(r.detail).toBe('host not connected')
  })
})

describe('controlResultFromError', () => {
  it('classifies a ProtocolMismatchError as EPROTO', () => {
    const r = controlResultFromError('conv_e', 'kill', new ProtocolMismatchError('proto 2 != 1'))
    expect(r.ok).toBe(false)
    expect(r.code).toBe('EPROTO')
    expect(r.detail).toContain('proto')
  })

  it('uses the fallback code for a generic error', () => {
    const r = controlResultFromError('conv_f', 'reply', new Error('socket gone'), 'ENOCONN')
    expect(r.code).toBe('ENOCONN')
    expect(r.detail).toBe('socket gone')
  })

  it('defaults the fallback code to EUNKNOWN', () => {
    const r = controlResultFromError('conv_g', 'reply', new Error('mystery'))
    expect(r.code).toBe('EUNKNOWN')
  })

  it('stringifies a non-Error throw', () => {
    const r = controlResultFromError('conv_h', 'kill', 'plain string')
    expect(r.detail).toBe('plain string')
  })
})
