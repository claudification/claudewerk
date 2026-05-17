import { afterEach, describe, expect, it } from 'bun:test'
import { ProtocolMismatchError } from './client'
import { type FakeDaemon, startFakeDaemon } from './fake-daemon'
import {
  type DaemonSubscribeFrame,
  isErrorFrame,
  isSnapshot,
  parseSubscribeFrame,
  type SubscribeCloseReason,
  splitFrames,
  subscribe,
} from './subscribe'

describe('parseSubscribeFrame', () => {
  it('parses a snapshot frame', () => {
    // Shape verified live against CC 2.1.143.
    const line = JSON.stringify({
      type: 'snapshot',
      record: { short: 'aeb185f9', sessionId: 'aeb185f9-c7c3', cwd: '/tmp', state: 'working' },
      streamTail: ['[2J', 'hello'],
    })
    const frame = parseSubscribeFrame(line)
    expect(isErrorFrame(frame)).toBe(false)
    if (!isErrorFrame(frame)) {
      expect(isSnapshot(frame)).toBe(true)
      if (isSnapshot(frame)) {
        expect(frame.record.short).toBe('aeb185f9')
        expect(frame.streamTail).toEqual(['[2J', 'hello'])
      }
    }
  })

  it('parses an incremental delta frame', () => {
    const frame = parseSubscribeFrame('{"type":"state","state":"done"}')
    expect(isErrorFrame(frame)).toBe(false)
    if (!isErrorFrame(frame)) expect(frame.type).toBe('state')
  })

  it('classifies a daemon error response as an error frame', () => {
    const frame = parseSubscribeFrame('{"ok":false,"error":"no such job","code":"ENOJOB"}')
    expect(isErrorFrame(frame)).toBe(true)
    if (isErrorFrame(frame)) expect(frame.code).toBe('ENOJOB')
  })

  it('classifies an EPROTO response as an error frame', () => {
    const frame = parseSubscribeFrame('{"ok":false,"error":"bad proto","code":"EPROTO"}')
    expect(isErrorFrame(frame)).toBe(true)
    if (isErrorFrame(frame)) expect(frame.code).toBe('EPROTO')
  })

  it('throws on a non-JSON frame', () => {
    expect(() => parseSubscribeFrame('not json')).toThrow()
  })

  it('throws on a frame with no string `type`', () => {
    expect(() => parseSubscribeFrame('{"record":{}}')).toThrow()
  })

  it('throws on a snapshot missing `record`', () => {
    expect(() => parseSubscribeFrame('{"type":"snapshot"}')).toThrow()
  })
})

describe('splitFrames', () => {
  it('splits complete lines and returns the trailing partial', () => {
    const { lines, rest } = splitFrames('{"type":"a"}\n{"type":"b"}\n{"type":"c"')
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}'])
    expect(rest).toBe('{"type":"c"')
  })

  it('returns no lines and the whole buffer when no newline is present', () => {
    const { lines, rest } = splitFrames('{"type":"partial"')
    expect(lines).toEqual([])
    expect(rest).toBe('{"type":"partial"')
  })

  it('reassembles a frame split across two chunks', () => {
    const first = splitFrames('{"type":"sna')
    expect(first.lines).toEqual([])
    const second = splitFrames(`${first.rest}pshot"}\n`)
    expect(second.lines).toEqual(['{"type":"snapshot"}'])
    expect(second.rest).toBe('')
  })

  it('drops empty lines between frames', () => {
    const { lines } = splitFrames('{"type":"a"}\n\n{"type":"b"}\n')
    expect(lines).toEqual(['{"type":"a"}', '{"type":"b"}'])
  })
})

describe('subscribe against a fake daemon', () => {
  let daemon: FakeDaemon | undefined

  afterEach(async () => {
    await daemon?.close()
    daemon = undefined
  })

  /** Run a subscription to completion, collecting every event and the outcome. */
  function runSubscription(
    sockPath: string,
    short: string,
  ): Promise<{ events: DaemonSubscribeFrame[]; reason: SubscribeCloseReason; error?: Error }> {
    return new Promise(resolve => {
      const events: DaemonSubscribeFrame[] = []
      let error: Error | undefined
      subscribe(sockPath, short, {
        onEvent: frame => events.push(frame),
        onError: err => {
          error = err
        },
        onClose: reason => resolve({ events, reason, error }),
      })
    })
  }

  it('delivers the snapshot then incremental deltas, then closes', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      expect(req.op).toBe('subscribe')
      expect(req.proto).toBe(1)
      expect(req.short).toBe('aeb185f9')
      conn.send({
        type: 'snapshot',
        record: { short: 'aeb185f9', sessionId: 's', cwd: '/tmp', state: 'working' },
        streamTail: [],
      })
      conn.send({ type: 'state', state: 'done' })
      conn.end()
    })
    const { events, reason } = await runSubscription(daemon.sockPath, 'aeb185f9')
    expect(events).toHaveLength(2)
    expect(isSnapshot(events[0] as DaemonSubscribeFrame)).toBe(true)
    expect(events[1]?.type).toBe('state')
    expect(reason).toBe('socket-closed')
  })

  it('maps an EPROTO error frame to ProtocolMismatchError', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ ok: false, error: 'protocol bumped', code: 'EPROTO' })
      conn.end()
    })
    const { reason, error } = await runSubscription(daemon.sockPath, 'x')
    expect(reason).toBe('daemon-error')
    expect(error).toBeInstanceOf(ProtocolMismatchError)
  })

  it('surfaces a non-EPROTO error frame as a daemon-error close', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ ok: false, error: 'no such job', code: 'ENOJOB' })
      conn.end()
    })
    const { reason, error } = await runSubscription(daemon.sockPath, 'ghost')
    expect(reason).toBe('daemon-error')
    expect(error?.message).toMatch(/ENOJOB/)
  })

  it('reassembles a frame split across two socket writes', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      const frame = `${JSON.stringify({ type: 'snapshot', record: { short: 's', sessionId: 's', cwd: '/', state: 'idle' } })}\n`
      conn.raw(frame.slice(0, 10))
      setTimeout(() => {
        conn.raw(frame.slice(10))
        conn.end()
      }, 20)
    })
    const { events, reason } = await runSubscription(daemon.sockPath, 's')
    expect(events).toHaveLength(1)
    expect(isSnapshot(events[0] as DaemonSubscribeFrame)).toBe(true)
    expect(reason).toBe('socket-closed')
  })

  it('closes on demand via the handle and reports closed', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ type: 'snapshot', record: { short: 's', sessionId: 's', cwd: '/', state: 'working' } })
      // hold the connection open
    })
    const closed = await new Promise<SubscribeCloseReason>(resolve => {
      const handle = subscribe(daemon!.sockPath, 's', {
        onEvent: () => handle.close(),
        onClose: reason => {
          expect(handle.closed).toBe(true)
          resolve(reason)
        },
      })
    })
    expect(closed).toBe('client-closed')
  })

  it('reports a socket-error close when the daemon socket is absent', async () => {
    const { reason, error } = await runSubscription('/tmp/cc-daemon-test-missing.sock', 's')
    expect(reason).toBe('socket-error')
    expect(error?.message).toMatch(/socket error/)
  })
})
