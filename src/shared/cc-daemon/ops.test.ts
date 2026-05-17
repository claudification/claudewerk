import { afterEach, describe, expect, it } from 'bun:test'
import { ProtocolMismatchError, request } from './client'
import { type FakeDaemon, startFakeDaemon } from './fake-daemon'
import { has, leases, list, ping } from './ops'
import { CC_DAEMON_PROTO } from './types'

let daemon: FakeDaemon | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

describe('ops against a fake daemon', () => {
  it('ping resolves the daemon ok response', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      expect(req.proto).toBe(CC_DAEMON_PROTO) // client stamps every frame
      expect(req.op).toBe('ping')
      conn.send({ ok: true, op: 'ping', version: '2.1.143', proto: 1 })
      conn.end()
    })
    const resp = await ping(daemon.sockPath)
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.version).toBe('2.1.143')
  })

  it('list returns inline job records', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({
        ok: true,
        op: 'list',
        jobs: [{ short: 'aeb185f9', sessionId: 'aeb185f9-c7c3', cwd: '/tmp', state: 'done' }],
      })
      conn.end()
    })
    const resp = await list(daemon.sockPath)
    expect(resp.jobs).toHaveLength(1)
    expect(resp.jobs[0]?.short).toBe('aeb185f9')
  })

  it('list throws when the daemon answers an error frame', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ ok: false, error: 'daemon busy' })
      conn.end()
    })
    expect(list(daemon.sockPath)).rejects.toThrow(/daemon busy/)
  })

  it('has reports job liveness', async () => {
    daemon = await startFakeDaemon((req, conn) => {
      expect(req.short).toBe('aeb185f9')
      conn.send({ ok: true, op: 'has', alive: true, present: true })
      conn.end()
    })
    const resp = await has(daemon.sockPath, 'aeb185f9')
    expect(resp.ok).toBe(true)
    if (resp.ok) expect(resp.alive).toBe(true)
  })

  it('leases returns the client list', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ ok: true, op: 'leases', clients: [{ label: 'sentinel', cwd: '/x', pid: 1 }] })
      conn.end()
    })
    const resp = await leases(daemon.sockPath)
    expect(resp.ok).toBe(true)
  })

  it('maps an EPROTO error frame to ProtocolMismatchError', async () => {
    daemon = await startFakeDaemon((_req, conn) => {
      conn.send({ ok: false, error: 'unsupported proto', code: 'EPROTO' })
      conn.end()
    })
    expect(request(daemon.sockPath, { op: 'ping' })).rejects.toBeInstanceOf(ProtocolMismatchError)
  })

  it('times out when the daemon never answers', async () => {
    daemon = await startFakeDaemon(() => {
      /* hold the connection, send nothing */
    })
    expect(request(daemon.sockPath, { op: 'ping' }, { timeoutMs: 150 })).rejects.toThrow(/timed out/)
  })

  it('rejects when the socket path does not exist', async () => {
    expect(request('/tmp/cc-daemon-test-nonexistent.sock', { op: 'ping' })).rejects.toThrow(/socket error/)
  })
})
