import { describe, expect, it } from 'bun:test'
import { encodeFrame, parseResponse } from './client'
import { CC_DAEMON_PROTO } from './types'

describe('encodeFrame', () => {
  it('stamps proto and terminates with a newline', () => {
    const frame = encodeFrame({ op: 'ping' })
    expect(frame.endsWith('\n')).toBe(true)
    expect(JSON.parse(frame.trim())).toEqual({ proto: CC_DAEMON_PROTO, op: 'ping' })
  })

  it('carries op fields alongside proto', () => {
    const frame = encodeFrame({ op: 'has', short: 'aeb185f9' })
    expect(JSON.parse(frame.trim())).toEqual({ proto: CC_DAEMON_PROTO, op: 'has', short: 'aeb185f9' })
  })
})

describe('parseResponse', () => {
  it('parses a verified ok response', () => {
    // Exact frame captured live from CC 2.1.143.
    const resp = parseResponse('{"ok":true,"op":"ping","version":"2.1.143","proto":1}')
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.op).toBe('ping')
  })

  it('parses an error response with a code', () => {
    const resp = parseResponse('{"ok":false,"error":"no such job","code":"ENOJOB"}')
    expect(resp.ok).toBe(false)
    if (!resp.ok) expect(resp.code).toBe('ENOJOB')
  })

  it('throws on a non-JSON frame', () => {
    expect(() => parseResponse('not json at all')).toThrow()
  })

  it('throws on a JSON frame with no boolean `ok`', () => {
    expect(() => parseResponse('{"op":"ping"}')).toThrow()
  })
})
