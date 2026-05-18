/**
 * Unit tests for the cc-daemon PTY-socket framing codec (Tier 1 -- pure, fast,
 * no daemon). The header layout `[len:u32be][kind:u8][payload]` is live-verified
 * against the 2.1.143 daemon; these tests pin the codec to it.
 */
import { describe, expect, test } from 'bun:test'
import {
  type DaemonPtyFrame,
  encodeControlFrame,
  encodePtyFrame,
  encodePtyInput,
  FRAME_KIND_CONTROL,
  FRAME_KIND_PTY,
  MAX_FRAME_PAYLOAD_BYTES,
  makePtyFrameDecoder,
  parseControlMessage,
} from './frame'

describe('encodePtyFrame', () => {
  test('lays the header out as [len:u32be][kind:u8]', () => {
    const frame = encodePtyFrame(FRAME_KIND_PTY, Buffer.from('hi'))
    expect(frame.readUInt32BE(0)).toBe(2)
    expect(frame.readUInt8(4)).toBe(0)
    expect(frame.subarray(5).toString()).toBe('hi')
  })

  test('matches the live-verified hello frame header bytes', () => {
    // Daemon sent header `00 00 00 31 01` for a 49-byte kind-1 hello payload.
    const hello = '{"t":"hello","replPid":14953,"version":"2.1.143"}'
    expect(hello.length).toBe(0x31)
    const frame = encodePtyFrame(FRAME_KIND_CONTROL, Buffer.from(hello))
    expect([...frame.subarray(0, 5)]).toEqual([0x00, 0x00, 0x00, 0x31, 0x01])
  })

  test('rejects an oversized payload', () => {
    expect(() => encodePtyFrame(FRAME_KIND_PTY, Buffer.alloc(MAX_FRAME_PAYLOAD_BYTES + 1))).toThrow(/exceeds/)
  })
})

describe('encodePtyInput / encodeControlFrame', () => {
  test('encodePtyInput accepts a string and a Buffer alike', () => {
    expect(encodePtyInput('x').equals(encodePtyInput(Buffer.from('x')))).toBe(true)
    expect(encodePtyInput('x').readUInt8(4)).toBe(FRAME_KIND_PTY)
  })

  test('encodeControlFrame produces a kind-1 JSON frame', () => {
    const frame = encodeControlFrame({ t: 'resize', cols: 100, rows: 30 })
    expect(frame.readUInt8(4)).toBe(FRAME_KIND_CONTROL)
    expect(JSON.parse(frame.subarray(5).toString())).toEqual({ t: 'resize', cols: 100, rows: 30 })
  })
})

describe('makePtyFrameDecoder', () => {
  test('decodes a single whole frame', () => {
    const decode = makePtyFrameDecoder()
    const frames = decode(encodePtyFrame(FRAME_KIND_PTY, Buffer.from('output')))
    expect(frames).toHaveLength(1)
    expect(frames[0]).toEqual({ kind: 0, payload: Buffer.from('output') } as DaemonPtyFrame)
  })

  test('decodes several frames from one chunk', () => {
    const decode = makePtyFrameDecoder()
    const chunk = Buffer.concat([
      encodePtyFrame(FRAME_KIND_PTY, Buffer.from('a')),
      encodeControlFrame({ t: 'live' }),
      encodePtyFrame(FRAME_KIND_PTY, Buffer.from('b')),
    ])
    const frames = decode(chunk)
    expect(frames.map(f => f.kind)).toEqual([0, 1, 0])
    expect(frames[0].payload.toString()).toBe('a')
    expect(parseControlMessage(frames[1].payload).t).toBe('live')
    expect(frames[2].payload.toString()).toBe('b')
  })

  test('reassembles a frame split across chunks', () => {
    const decode = makePtyFrameDecoder()
    const whole = encodePtyFrame(FRAME_KIND_PTY, Buffer.from('split-payload'))
    expect(decode(whole.subarray(0, 7))).toHaveLength(0) // header + 2 payload bytes
    const frames = decode(whole.subarray(7))
    expect(frames).toHaveLength(1)
    expect(frames[0].payload.toString()).toBe('split-payload')
  })

  test('holds a partial trailing frame until the rest arrives', () => {
    const decode = makePtyFrameDecoder()
    const a = encodePtyFrame(FRAME_KIND_PTY, Buffer.from('first'))
    const b = encodePtyFrame(FRAME_KIND_PTY, Buffer.from('second'))
    const glued = Buffer.concat([a, b.subarray(0, 3)])
    expect(decode(glued)).toHaveLength(1) // only `a` is complete
    const frames = decode(b.subarray(3))
    expect(frames).toHaveLength(1)
    expect(frames[0].payload.toString()).toBe('second')
  })

  test('throws on a corrupt oversized length header', () => {
    const decode = makePtyFrameDecoder()
    const bad = Buffer.alloc(8)
    bad.writeUInt32BE(MAX_FRAME_PAYLOAD_BYTES + 1, 0)
    expect(() => decode(bad)).toThrow(/corrupt stream/)
  })
})

describe('parseControlMessage', () => {
  test('parses a tagged control object', () => {
    expect(parseControlMessage(Buffer.from('{"t":"hello","replPid":14953}'))).toEqual({
      t: 'hello',
      replPid: 14953,
    })
  })

  test('throws on non-JSON', () => {
    expect(() => parseControlMessage(Buffer.from('not json'))).toThrow(/not JSON/)
  })

  test('throws when the `t` tag is missing', () => {
    expect(() => parseControlMessage(Buffer.from('{"foo":1}'))).toThrow(/missing string `t`/)
  })
})
