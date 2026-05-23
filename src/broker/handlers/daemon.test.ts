import { describe, expect, it } from 'bun:test'
import type { Conversation } from '../../shared/protocol'
import { GuardError, type HandlerContext } from '../handler-context'
import {
  daemonControlResult,
  daemonRespawnStale,
  isValidDaemonJob,
  mapDaemonState,
  normalizeDaemonBlockObserved,
  normalizeDaemonControlResult,
  normalizeDaemonLaunchEvent,
  normalizeDaemonStatePatch,
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

// ─── Phase G -- remote control ─────────────────────────────────────────────

describe('normalizeDaemonControlResult', () => {
  const base = { type: 'daemon_control_result', conversationId: 'conv_x', op: 'reply', ok: true, t: 99 }

  it('normalizes a well-formed ok result', () => {
    const r = normalizeDaemonControlResult(base)
    expect(r).not.toBeNull()
    expect(r?.op).toBe('reply')
    expect(r?.ok).toBe(true)
    expect(r?.t).toBe(99)
  })

  it('carries code + detail through on a failure result', () => {
    const r = normalizeDaemonControlResult({ ...base, ok: false, code: 'ENOREPLY', detail: 'mid-turn' })
    expect(r?.ok).toBe(false)
    expect(r?.code).toBe('ENOREPLY')
    expect(r?.detail).toBe('mid-turn')
  })

  it('accepts every documented control op', () => {
    for (const op of ['reply', 'permission_response', 'kill', 'respawn_stale']) {
      expect(normalizeDaemonControlResult({ ...base, op })).not.toBeNull()
    }
  })

  it('rejects a missing conversationId, an unknown op, and a non-boolean ok', () => {
    expect(normalizeDaemonControlResult({ ...base, conversationId: '' })).toBeNull()
    expect(normalizeDaemonControlResult({ ...base, op: 'bogus' })).toBeNull()
    expect(normalizeDaemonControlResult({ ...base, ok: 'yes' })).toBeNull()
  })

  it('defaults t to now when absent', () => {
    const before = Date.now()
    const r = normalizeDaemonControlResult({ type: 'daemon_control_result', conversationId: 'c', op: 'kill', ok: true })
    expect(r?.t).toBeGreaterThanOrEqual(before)
  })
})

/** Minimal fake socket recording every frame written to it. */
function fakeSocket(): { sent: string[] } & { send(s: string): void } {
  const sent: string[] = []
  return { sent, send: (s: string) => sent.push(s) }
}

interface FakeCtxResult {
  ctx: HandlerContext
  broadcasts: { msg: Record<string, unknown>; project: string }[]
  logs: string[]
}

/** Build a HandlerContext fake exposing only what the Phase-G handlers touch. */
function makeFakeCtx(opts: {
  conversation?: Conversation
  socket?: { send(s: string): void }
  permissionThrows?: boolean
}): FakeCtxResult {
  const broadcasts: { msg: Record<string, unknown>; project: string }[] = []
  const logs: string[] = []
  const conv = opts.conversation
  const ctx = {
    conversations: {
      getConversation: (id: string) => (conv && conv.id === id ? conv : undefined),
      getConversationSocket: (id: string) => (opts.socket && conv?.id === id ? opts.socket : undefined),
      getConnectionIds: () => [],
      findSocketByConversationId: () => undefined,
    },
    requirePermission: () => {
      if (opts.permissionThrows) throw new GuardError('permission denied')
    },
    broadcastScoped: (msg: Record<string, unknown>, project: string) => broadcasts.push({ msg, project }),
    log: {
      info: (m: string) => logs.push(`info:${m}`),
      debug: (m: string) => logs.push(`debug:${m}`),
      error: (m: string) => logs.push(`error:${m}`),
    },
  } as unknown as HandlerContext
  return { ctx, broadcasts, logs }
}

/** A daemon-backed conversation row. */
function daemonConv(id = 'conv_d'): Conversation {
  return { id, project: 'claude:///tmp/proj', agentHostType: 'daemon', status: 'active' } as Conversation
}

describe('daemonControlResult handler', () => {
  it('re-broadcasts a valid result scoped to the conversation project', () => {
    const { ctx, broadcasts } = makeFakeCtx({ conversation: daemonConv() })
    daemonControlResult(ctx, { type: 'daemon_control_result', conversationId: 'conv_d', op: 'reply', ok: true, t: 1 })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.project).toBe('claude:///tmp/proj')
    expect(broadcasts[0]?.msg.op).toBe('reply')
  })

  it('ignores a malformed payload', () => {
    const { ctx, broadcasts } = makeFakeCtx({ conversation: daemonConv() })
    daemonControlResult(ctx, { type: 'daemon_control_result', conversationId: 'conv_d', op: 'bogus', ok: true })
    expect(broadcasts).toHaveLength(0)
  })

  it('ignores a result for an unknown conversation', () => {
    const { ctx, broadcasts } = makeFakeCtx({})
    daemonControlResult(ctx, { type: 'daemon_control_result', conversationId: 'conv_gone', op: 'kill', ok: true })
    expect(broadcasts).toHaveLength(0)
  })
})

describe('daemonRespawnStale handler', () => {
  it('forwards daemon_respawn_stale to the connected host socket', () => {
    const socket = fakeSocket()
    const { ctx } = makeFakeCtx({ conversation: daemonConv(), socket })
    daemonRespawnStale(ctx, { conversationId: 'conv_d' })
    expect(socket.sent).toHaveLength(1)
    expect(JSON.parse(socket.sent[0] as string)).toEqual({ type: 'daemon_respawn_stale', conversationId: 'conv_d' })
  })

  it('emits an EHOSTGONE failure result when no host socket is connected', () => {
    const { ctx, broadcasts } = makeFakeCtx({ conversation: daemonConv() })
    daemonRespawnStale(ctx, { conversationId: 'conv_d' })
    expect(broadcasts).toHaveLength(1)
    expect(broadcasts[0]?.msg.ok).toBe(false)
    expect(broadcasts[0]?.msg.code).toBe('EHOSTGONE')
    expect(broadcasts[0]?.msg.op).toBe('respawn_stale')
  })

  it('throws GuardError for a missing / unknown conversation', () => {
    const { ctx } = makeFakeCtx({})
    expect(() => daemonRespawnStale(ctx, {})).toThrow(GuardError)
    expect(() => daemonRespawnStale(ctx, { conversationId: 'conv_nope' })).toThrow(GuardError)
  })

  it('throws GuardError for a non-daemon conversation', () => {
    const conv = { ...daemonConv(), agentHostType: 'claude' } as Conversation
    const { ctx } = makeFakeCtx({ conversation: conv })
    expect(() => daemonRespawnStale(ctx, { conversationId: 'conv_d' })).toThrow(/not a daemon/)
  })

  it('throws GuardError when the caller lacks chat permission', () => {
    const { ctx } = makeFakeCtx({ conversation: daemonConv(), permissionThrows: true })
    expect(() => daemonRespawnStale(ctx, { conversationId: 'conv_d' })).toThrow(GuardError)
  })
})

describe('normalizeDaemonStatePatch', () => {
  it('returns null without a conversationId', () => {
    expect(normalizeDaemonStatePatch({ state: 'working' })).toBeNull()
  })

  it('normalizes a working patch with detail/tempo/needs', () => {
    const r = normalizeDaemonStatePatch({
      conversationId: 'conv_x',
      state: 'working',
      tempo: 'idle',
      detail: 'running echo',
      needs: '',
      raw: { state: 'working' },
      t: 42,
    })
    expect(r).toEqual({
      type: 'daemon_state_patch',
      conversationId: 'conv_x',
      state: 'working',
      tempo: 'idle',
      detail: 'running echo',
      needs: '',
      raw: { state: 'working' },
      t: 42,
    })
  })

  it('drops an unknown state value', () => {
    const r = normalizeDaemonStatePatch({ conversationId: 'conv_x', state: 'bogus' })
    expect(r?.state).toBeUndefined()
  })
})

describe('normalizeDaemonBlockObserved', () => {
  it('returns null without a conversationId', () => {
    expect(normalizeDaemonBlockObserved({ needs: 'allow?' })).toBeNull()
  })

  it('normalizes needs + requestId', () => {
    const r = normalizeDaemonBlockObserved({
      conversationId: 'conv_x',
      needs: 'allow Bash?',
      requestId: 'req_1',
      raw: { block: { requestId: 'req_1' } },
      t: 7,
    })
    expect(r).toEqual({
      type: 'daemon_block_observed',
      conversationId: 'conv_x',
      needs: 'allow Bash?',
      requestId: 'req_1',
      raw: { block: { requestId: 'req_1' } },
      t: 7,
    })
  })
})
