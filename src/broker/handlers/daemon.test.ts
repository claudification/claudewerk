import { describe, expect, it } from 'bun:test'
import { isValidDaemonJob, mapDaemonState, parseDaemonJobs, registerDaemonHandlers } from './daemon'

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

describe('registerDaemonHandlers', () => {
  it('registers without throwing', () => {
    expect(() => registerDaemonHandlers()).not.toThrow()
  })
})
