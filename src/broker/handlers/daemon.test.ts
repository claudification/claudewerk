import { describe, expect, it } from 'bun:test'
import {
  isValidDaemonJob,
  mapDaemonState,
  normalizeDaemonLaunchEvent,
  parseDaemonJobs,
  registerDaemonHandlers,
} from './daemon'

describe('mapDaemonState', () => {
  it('maps terminal states to ended', () => {
    for (const s of ['done', 'failed', 'stopped', 'crashed']) {
      expect(mapDaemonState(s)).toBe('ended')
    }
  })

  it('maps boot states to starting', () => {
    for (const s of ['starting', 'resuming', 'adopted']) {
      expect(mapDaemonState(s)).toBe('starting')
    }
  })

  it('maps awaiting-input states to idle', () => {
    for (const s of ['question', 'blocked', 'idle']) {
      expect(mapDaemonState(s)).toBe('idle')
    }
  })

  it('maps running states to active', () => {
    for (const s of ['working', 'tool_use', 'midturn', 'running', 'active']) {
      expect(mapDaemonState(s)).toBe('active')
    }
  })

  it('falls back to active for an unknown state', () => {
    expect(mapDaemonState('some-future-state')).toBe('active')
  })
})

describe('isValidDaemonJob', () => {
  const valid = { conversationId: 'conv_x', cwd: '/tmp', state: 'working', short: 'aeb1' }

  it('accepts a well-formed roster job', () => {
    expect(isValidDaemonJob(valid)).toBe(true)
  })

  it('rejects a job missing a required field', () => {
    expect(isValidDaemonJob({ ...valid, cwd: undefined })).toBe(false)
    expect(isValidDaemonJob({ ...valid, short: 42 })).toBe(false)
  })

  it('rejects null and non-objects', () => {
    expect(isValidDaemonJob(null)).toBe(false)
    expect(isValidDaemonJob('nope')).toBe(false)
  })
})

describe('parseDaemonJobs', () => {
  it('filters a wire array down to valid jobs', () => {
    const jobs = parseDaemonJobs([
      { conversationId: 'conv_a', cwd: '/a', state: 'working', short: 'a1' },
      { conversationId: 'conv_b' }, // malformed
    ])
    expect(jobs).toHaveLength(1)
    expect(jobs[0]?.conversationId).toBe('conv_a')
  })

  it('returns an empty array for non-array input', () => {
    expect(parseDaemonJobs(undefined)).toEqual([])
    expect(parseDaemonJobs({})).toEqual([])
  })
})

describe('normalizeDaemonLaunchEvent', () => {
  const base = { type: 'daemon_launch_event', conversationId: 'conv_x', step: 'attached', daemonMode: 'new', t: 123 }

  it('normalizes a well-formed event', () => {
    const e = normalizeDaemonLaunchEvent(base)
    expect(e).not.toBeNull()
    expect(e?.step).toBe('attached')
    expect(e?.daemonMode).toBe('new')
    expect(e?.t).toBe(123)
  })

  it('carries optional short/detail/raw through', () => {
    const e = normalizeDaemonLaunchEvent({ ...base, short: 'aeb185f9', detail: 'ack', raw: { via: 'spare' } })
    expect(e?.short).toBe('aeb185f9')
    expect(e?.detail).toBe('ack')
    expect(e?.raw).toEqual({ via: 'spare' })
  })

  it('defaults t to now when absent', () => {
    const before = Date.now()
    const e = normalizeDaemonLaunchEvent({
      type: 'daemon_launch_event',
      conversationId: 'c',
      step: 'attached',
      daemonMode: 'new',
    })
    expect(e?.t).toBeGreaterThanOrEqual(before)
  })

  it('rejects a missing conversationId', () => {
    expect(normalizeDaemonLaunchEvent({ ...base, conversationId: undefined })).toBeNull()
    expect(normalizeDaemonLaunchEvent({ ...base, conversationId: '' })).toBeNull()
  })

  it('rejects an unknown launch step', () => {
    expect(normalizeDaemonLaunchEvent({ ...base, step: 'bogus_step' })).toBeNull()
  })

  it('rejects an invalid daemonMode', () => {
    expect(normalizeDaemonLaunchEvent({ ...base, daemonMode: 'sideways' })).toBeNull()
  })

  it('accepts every documented launch step', () => {
    const steps = [
      'dispatch_requested',
      'worker_dispatched',
      'attach_started',
      'attach_retry',
      'attached',
      'attach_lost',
      'reattached',
      'worker_gone',
    ]
    for (const step of steps) {
      expect(normalizeDaemonLaunchEvent({ ...base, step })).not.toBeNull()
    }
  })
})

describe('registerDaemonHandlers', () => {
  it('registers without throwing', () => {
    expect(() => registerDaemonHandlers()).not.toThrow()
  })
})
