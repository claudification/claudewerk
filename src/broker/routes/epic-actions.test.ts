/**
 * The two broker actions that WRITE. `inspect` and `list` are covered by
 * `epic-inspect-view.test.ts` (the shaping); what matters here is the policy:
 * a live overseer is not a stuck one, and a successful break is audited.
 *
 * Effects come through `configureActionIo`, never `mock.module` -- that one is
 * process-wide in Bun and would leak these doubles into every test file that
 * happens to run afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EpicLease } from '../../shared/epic-lease'
import type { Conversation, EpicResult } from '../../shared/protocol'
import type { BeatOutcome } from '../epic-executor'
import type { SweepDeps } from '../epic-sweep-loop'
import { actionBeat, actionBreakLease, configureActionIo, resetActionIo } from './epic-actions'

const P = 'claude://s/p'

let lease: EpicLease | null
let convs: Conversation[]
let released: number
let batonBodies: string[]
let getError: string | undefined
let releaseOk: boolean

function conv(id: string, status = 'active'): Conversation {
  return { id, project: P, status } as unknown as Conversation
}

function deps(): SweepDeps {
  return {
    getAllConversations: () => convs,
    isLive: (c: Conversation) => c.status !== 'ended',
  } as unknown as SweepDeps
}

beforeEach(() => {
  lease = { convId: 'conv_dead', gen: 4, at: '2026-08-18T09:00:00.000Z' }
  convs = []
  released = 0
  batonBodies = []
  getError = undefined
  releaseOk = true

  configureActionIo({
    fetchEpicRun: async () => ({ run: null, baton: [], lease, ...(getError ? { error: getError } : {}) }),
    sendEpicOp: async (_d, _p, op) => {
      if (op.op === 'release') released++
      return (releaseOk ? { ok: true } : { ok: false, error: 'sentinel refused' }) as EpicResult
    },
    appendBaton: async (_d, _p, _e, entry) => {
      batonBodies.push(entry.body)
      return {
        ok: true,
        logEntry: { ts: 'now', kind: entry.kind, convId: entry.convId, body: entry.body },
      } as EpicResult
    },
  })
})

afterEach(resetActionIo)

describe('break_lease', () => {
  test('a free lease is a no-op success, not an error -- asking twice must be safe', async () => {
    lease = { convId: '', gen: 4, at: '' }
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: true })
    expect(released).toBe(0)
  })

  test('an epic that has never run has nothing to break', async () => {
    lease = null
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: true })
    expect(released).toBe(0)
  })

  test('a holder with no conversation in the registry is broken -- that IS the stuck case', async () => {
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1', reason: 'broker restarted' })).toMatchObject({
      ok: true,
    })
    expect(released).toBe(1)
  })

  test('an ENDED holder is broken without force', async () => {
    convs = [conv('conv_dead', 'ended')]
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: true })
    expect(released).toBe(1)
  })

  test('a LIVE holder is refused -- this is an unstick tool, not a way to shoot a working overseer', async () => {
    convs = [conv('conv_dead')]
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 409 })
    expect(released).toBe(0)
  })

  test('force breaks a live holder, because sometimes it really is wedged', async () => {
    convs = [conv('conv_dead')]
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1', force: true })).toMatchObject({ ok: true })
    expect(released).toBe(1)
  })

  test('a break is AUDITED into the baton with the holder, its generation and the reason', async () => {
    await actionBreakLease(deps(), { project: P, epicId: 'e1', reason: 'overseer hung' })
    expect(batonBodies).toHaveLength(1)
    expect(batonBodies[0]).toContain('conv_dead')
    expect(batonBodies[0]).toContain('gen 4')
    expect(batonBodies[0]).toContain('overseer hung')
  })

  test('a break with no reason still writes an entry -- an unexplained break is worse unlogged', async () => {
    await actionBreakLease(deps(), { project: P, epicId: 'e1' })
    expect(batonBodies[0]).toContain('no reason given')
  })

  test('a failed release does NOT write a baton entry claiming it happened', async () => {
    releaseOk = false
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 502 })
    expect(batonBodies).toEqual([])
  })

  test('an unreachable sentinel fails loudly instead of reporting "no lease held"', async () => {
    getError = 'sentinel offline'
    expect(await actionBreakLease(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 502 })
    expect(released).toBe(0)
  })
})

describe('beat', () => {
  test('a performed beat reports what it did', async () => {
    const outcome: BeatOutcome = { epicId: 'e1', note: 'dispatched 1', actions: 1, spawned: ['conv_x'] }
    configureActionIo({ beatOneEpic: async () => ({ ok: true, outcome }) })
    expect(await actionBeat(deps(), { project: P, epicId: 'e1' })).toEqual({
      ok: true,
      beat: { note: 'dispatched 1', actions: 1, spawned: ['conv_x'] },
    })
  })

  test('a beat that hit an error keeps it rather than reporting a clean run', async () => {
    const outcome: BeatOutcome = { epicId: 'e1', note: 'no run artifact', actions: 0, spawned: [], error: 'boom' }
    configureActionIo({ beatOneEpic: async () => ({ ok: true, outcome }) })
    expect(await actionBeat(deps(), { project: P, epicId: 'e1' })).toMatchObject({ beat: { error: 'boom' } })
  })

  test('a refusal because the sweep is mid-tick is a 409, not a 500 -- it is normal, and retryable', async () => {
    configureActionIo({ beatOneEpic: async () => ({ ok: false, error: 'a sweep is already running' }) })
    expect(await actionBeat(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 409 })
  })
})
