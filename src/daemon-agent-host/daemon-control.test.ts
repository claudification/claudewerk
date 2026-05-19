import { describe, expect, it } from 'bun:test'
import { ProtocolMismatchError } from '../shared/cc-daemon/client'
import type { DaemonResponse } from '../shared/cc-daemon/types'
import type { DaemonControlResult } from '../shared/protocol'
import { createDaemonControl, type DaemonControlOps } from './daemon-control'

const OK: DaemonResponse = { ok: true, op: 'x' }

interface Harness {
  emitted: DaemonControlResult[]
  logs: string[]
  control: ReturnType<typeof createDaemonControl>
  /** Recorded (sock, short, text?) tuples per op. */
  calls: { op: string; args: unknown[] }[]
}

/** Build a control surface over fully-faked daemon ops. */
function makeHarness(ops: Partial<DaemonControlOps> = {}): Harness {
  const emitted: DaemonControlResult[] = []
  const logs: string[] = []
  const calls: { op: string; args: unknown[] }[] = []
  const wrap =
    (name: string, fn: (...a: never[]) => Promise<DaemonResponse>) =>
    async (...args: unknown[]): Promise<DaemonResponse> => {
      calls.push({ op: name, args })
      return fn(...(args as never[]))
    }
  const control = createDaemonControl({
    controlSock: '/tmp/fake.sock',
    daemonShort: 'abcd1234',
    conversationId: 'conv_testabcdef',
    emit: r => emitted.push(r),
    log: m => logs.push(m),
    ops: {
      reply: wrap('reply', ops.reply ?? (async () => OK)),
      kill: wrap('kill', ops.kill ?? (async () => OK)),
      respawnStale: wrap('respawnStale', ops.respawnStale ?? (async () => OK)),
    },
  })
  return { emitted, logs, control, calls }
}

describe('createDaemonControl -- reply', () => {
  it('runs the reply op with sock + short + text and emits an ok result', async () => {
    const h = makeHarness()
    const result = await h.control.reply('hello worker')
    expect(h.calls).toEqual([{ op: 'reply', args: ['/tmp/fake.sock', 'abcd1234', 'hello worker'] }])
    expect(result.ok).toBe(true)
    expect(result.op).toBe('reply')
    expect(h.emitted).toEqual([result])
  })

  it('emits a failure result carrying the daemon error code', async () => {
    const h = makeHarness({ reply: async () => ({ ok: false, error: 'mid-turn', code: 'ENOREPLY' }) })
    const result = await h.control.reply('x')
    expect(result.ok).toBe(false)
    expect(result.code).toBe('ENOREPLY')
    expect(result.detail).toBe('mid-turn')
    expect(h.emitted).toHaveLength(1)
  })

  it('turns a thrown op error into a failure result -- never rejects', async () => {
    const h = makeHarness({
      reply: () => {
        throw new Error('socket gone')
      },
    })
    const result = await h.control.reply('x')
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('socket gone')
    expect(h.emitted).toHaveLength(1)
  })
})

describe('createDaemonControl -- kill + respawn-stale', () => {
  it('runs the kill op and emits op=kill', async () => {
    const h = makeHarness()
    const result = await h.control.kill()
    expect(h.calls).toEqual([{ op: 'kill', args: ['/tmp/fake.sock', 'abcd1234'] }])
    expect(result.op).toBe('kill')
    expect(result.ok).toBe(true)
  })

  it('runs the respawn-stale op and emits op=respawn_stale', async () => {
    const h = makeHarness()
    const result = await h.control.respawnStale()
    expect(h.calls).toEqual([{ op: 'respawnStale', args: ['/tmp/fake.sock', 'abcd1234'] }])
    expect(result.op).toBe('respawn_stale')
    expect(result.ok).toBe(true)
  })

  it('classifies a ProtocolMismatchError as EPROTO (proto gate)', async () => {
    const h = makeHarness({
      kill: () => {
        throw new ProtocolMismatchError('proto 2 != 1')
      },
    })
    const result = await h.control.kill()
    expect(result.ok).toBe(false)
    expect(result.code).toBe('EPROTO')
  })
})

describe('createDaemonControl -- logging', () => {
  it('logs intent then outcome with full id context for every op', async () => {
    const h = makeHarness()
    await h.control.reply('hi')
    expect(
      h.logs.some(l => l.includes('op=reply') && l.includes('conv=conv_tes') && l.includes('short=abcd1234')),
    ).toBe(true)
    expect(h.logs.some(l => l.includes('op=reply') && l.includes('-> ok'))).toBe(true)
  })

  it('logs the daemon error code on failure', async () => {
    const h = makeHarness({ kill: async () => ({ ok: false, error: 'no job', code: 'ENOJOB' }) })
    await h.control.kill()
    expect(h.logs.some(l => l.includes('-> FAIL') && l.includes('code=ENOJOB'))).toBe(true)
  })
})
