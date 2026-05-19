/**
 * Unit tests for the `attach` held-duplex transport (Tier 1 -- no real daemon).
 * Drives the real attach client against `fake-daemon`, which exercises the true
 * wire path: newline-JSON ack frame, then raw PTY bytes on the same connection.
 */
import { afterEach, describe, expect, test } from 'bun:test'
import { type AttachCloseReason, attach, DaemonAttachError } from './attach'
import { ProtocolMismatchError } from './client'
import { type FakeConn, type FakeDaemon, startFakeDaemon } from './fake-daemon'

let daemon: FakeDaemon | null = null
afterEach(async () => {
  await daemon?.close()
  daemon = null
})

/** Resolve after `ms` -- lets async socket events settle. */
function tick(ms = 30): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** A standard attach ack, with optional overrides. */
function ackFrame(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { ok: true, op: 'attach', decModes: [1000, 2004], via: 'spare', tempo: 'active', state: 'running', ...extra }
}

describe('attach', () => {
  test('resolves with the parsed ack', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send(ackFrame({ state: 'blocked' }))
    })
    const handle = await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: () => {} })
    expect(handle.ack.state).toBe('blocked')
    expect(handle.ack.decModes).toEqual([1000, 2004])
    expect(handle.ack.via).toBe('spare')
    expect(handle.closed).toBe(false)
    handle.close()
  })

  test('streams raw PTY bytes after the ack to onData', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op !== 'attach') return
      conn.send(ackFrame())
      setTimeout(() => conn.rawBytes(Buffer.from('PTY-OUTPUT')), 10)
    })
    const chunks: Buffer[] = []
    const handle = await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: c => chunks.push(c) })
    await tick()
    expect(Buffer.concat(chunks).toString()).toBe('PTY-OUTPUT')
    handle.close()
  })

  test('delivers PTY bytes glued to the ack frame in one chunk', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      // ack newline-JSON and the first PTY bytes in a single write.
      if (req.op === 'attach') conn.raw(`${JSON.stringify(ackFrame())}\nGLUED-BYTES`)
    })
    const chunks: Buffer[] = []
    const handle = await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: c => chunks.push(c) })
    await tick()
    expect(Buffer.concat(chunks).toString()).toBe('GLUED-BYTES')
    handle.close()
  })

  test('writeInput sends raw bytes back to the worker', async () => {
    const received: Buffer[] = []
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op !== 'attach') return
      conn.onInput = data => received.push(data)
      conn.send(ackFrame())
    })
    const handle = await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: () => {} })
    handle.writeInput('typed input')
    await tick()
    expect(Buffer.concat(received).toString()).toBe('typed input')
    handle.close()
  })

  test('resize issues a resize control op on a fresh connection', async () => {
    let resizeReq: Record<string, unknown> | null = null
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send(ackFrame())
      if (req.op === 'resize') {
        resizeReq = req
        conn.send({ ok: true, op: 'resize' })
      }
    })
    const handle = await attach(daemon.sockPath, 'abcd1234', {
      cols: 80,
      rows: 24,
      attachId: 'att_fixed',
      onData: () => {},
    })
    await handle.resize(120, 40)
    expect(resizeReq).toMatchObject({ op: 'resize', short: 'abcd1234', cols: 120, rows: 40, attachId: 'att_fixed' })
    handle.close()
  })

  test('rejects when the daemon refuses the attach (ENOJOB)', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send({ ok: false, error: 'no such job', code: 'ENOJOB' })
    })
    expect(attach(daemon.sockPath, 'deadbeef', { cols: 80, rows: 24, onData: () => {} })).rejects.toThrow(/ENOJOB/)
  })

  test('a daemon refusal rejects as DaemonAttachError carrying the code', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send({ ok: false, error: 'worker still booting', code: 'ESTARTING' })
    })
    try {
      await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: () => {} })
      throw new Error('attach should have rejected')
    } catch (err) {
      expect(err).toBeInstanceOf(DaemonAttachError)
      expect((err as DaemonAttachError).code).toBe('ESTARTING')
    }
  })

  test('rejects an EPROTO refusal as ProtocolMismatchError', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send({ ok: false, error: 'proto mismatch', code: 'EPROTO' })
    })
    expect(attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: () => {} })).rejects.toBeInstanceOf(
      ProtocolMismatchError,
    )
  })

  test('close() ends the session and fires onClose', async () => {
    let closeReason: AttachCloseReason | null = null
    daemon = await startFakeDaemon((req, conn) => {
      if (req.op === 'attach') conn.send(ackFrame())
    })
    const handle = await attach(daemon.sockPath, 'abcd1234', {
      cols: 80,
      rows: 24,
      onData: () => {},
      onClose: reason => {
        closeReason = reason
      },
    })
    handle.close()
    await tick()
    expect(handle.closed).toBe(true)
    expect(closeReason as AttachCloseReason | null).toBe('client-closed')
  })

  test('writeInput after close is a no-op', async () => {
    const received: Buffer[] = []
    daemon = await startFakeDaemon((req, conn: FakeConn) => {
      if (req.op !== 'attach') return
      conn.onInput = data => received.push(data)
      conn.send(ackFrame())
    })
    const handle = await attach(daemon.sockPath, 'abcd1234', { cols: 80, rows: 24, onData: () => {} })
    handle.close()
    handle.writeInput('ignored')
    await tick()
    expect(received).toHaveLength(0)
  })
})
