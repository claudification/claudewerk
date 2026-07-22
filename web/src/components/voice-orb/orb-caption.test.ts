import { describe, expect, it } from 'vitest'
import { pickCaption } from './orb-caption'

const base = { error: null, leavingSoon: false, remainingMs: 0, lastLine: undefined }

describe('pickCaption', () => {
  it('shows the last thing the orb said', () => {
    expect(pickCaption({ ...base, lastLine: 'three are working' })).toEqual({
      text: 'three are working',
      tone: 'speech',
    })
  })

  it('a failure outranks everything -- it is what the user must act on', () => {
    const out = pickCaption({ ...base, error: 'microphone denied', leavingSoon: true, lastLine: 'hello' })
    expect(out).toEqual({ text: 'microphone denied', tone: 'error' })
  })

  it('counts the goodbye down in whole seconds, never to zero', () => {
    expect(pickCaption({ ...base, leavingSoon: true, remainingMs: 30_000 }).text).toBe(
      'stepping away in 30s -- say something',
    )
    expect(pickCaption({ ...base, leavingSoon: true, remainingMs: 1400 }).text).toContain('1s')
    expect(pickCaption({ ...base, leavingSoon: true, remainingMs: 0 }).text).toContain('1s')
  })

  it('is empty when there is nothing to say', () => {
    expect(pickCaption(base)).toEqual({ text: '', tone: 'speech' })
  })
})
