/**
 * The three broker actions that WRITE. `inspect` and `list` are covered by
 * `epic-inspect-view.test.ts` (the shaping); what matters here is the policy:
 * a live werk-master is not a stuck one, a successful break is audited, and a
 * delete refuses the one thing only the broker can see -- a live seat.
 *
 * Effects come through `configureActionIo`, never `mock.module` -- that one is
 * process-wide in Bun and would leak these doubles into every test file that
 * happens to run afterwards.
 */

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import type { EpicLease } from '../../shared/epic-lease'
import type { ProjectTaskMeta } from '../../shared/project-task-types'
import type { Conversation, EpicOpKind, EpicResult, EpicRunSnapshot } from '../../shared/protocol'
import type { BeatOutcome } from '../epic-executor'
import { isDeletedEpic, listArmedEpics, noteArmedEpic, resetArmedEpics } from '../epic-registry'
import type { SweepDeps } from '../epic-sweep-loop'
import { actionBeat, actionBreakLease, actionDelete, configureActionIo, resetActionIo } from './epic-actions'

const P = 'claude://s/p'

let lease: EpicLease | null
let convs: Conversation[]
let released: number
let batonBodies: string[]
let getError: string | undefined
let releaseOk: boolean
let run: EpicRunSnapshot | null
let cards: ProjectTaskMeta[]
let sentOps: EpicOpKind[]
let deleteOk: boolean
let published: number

function conv(id: string, status = 'active'): Conversation {
  return { id, project: P, status } as unknown as Conversation
}

/** A conversation carrying an epic launch tag -- the only kind `actionDelete`
 *  looks at, and the reason the refusal cannot be made sentinel-side. */
function seat(id: string, epicId: string, status = 'active'): Conversation {
  return { id, project: P, status, launchConfig: { epic: { epicId, role: 'werk-worker', gen: 1 } } } as Conversation
}

function endedRun(status: EpicRunSnapshot['status'] = 'aborted'): EpicRunSnapshot {
  return { epicId: 'e1', project: P, status } as EpicRunSnapshot
}

function card(slug: string, epic: string, status: string): ProjectTaskMeta {
  return { slug, title: slug, status, epic, tags: [], dependsOn: [] } as unknown as ProjectTaskMeta
}

function deps(): SweepDeps {
  return {
    getAllConversations: () => convs,
    isLive: (c: Conversation) => c.status !== 'ended',
    publishActivity: () => {
      published++
    },
  } as unknown as SweepDeps
}

beforeEach(() => {
  lease = { convId: 'conv_dead', gen: 4, at: '2026-08-18T09:00:00.000Z' }
  convs = []
  released = 0
  batonBodies = []
  getError = undefined
  releaseOk = true
  run = null
  cards = []
  sentOps = []
  deleteOk = true
  published = 0
  resetArmedEpics()

  configureActionIo({
    fetchEpicRun: async () => ({
      run,
      baton: [],
      acknowledgedCardIds: [],
      dispatchCounts: {},
      lease,
      ...(getError ? { error: getError } : {}),
    }),
    fetchBoardCards: async () => cards,
    sendEpicOp: async (_d, _p, op) => {
      sentOps.push(op.op)
      if (op.op === 'release') released++
      if (op.op === 'delete') {
        return (
          deleteOk
            ? { ok: true, deletedTo: '.rclaude/project/epics/.deleted/e1-2026-08-21T00-00-00-000Z' }
            : { ok: false, error: 'run is armed -- only a paused, aborted or complete run can be deleted' }
        ) as EpicResult
      }
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

afterEach(() => {
  resetActionIo()
  resetArmedEpics()
})

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

  test('a LIVE holder is refused -- this is an unstick tool, not a way to shoot a working werk-master', async () => {
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
    await actionBreakLease(deps(), { project: P, epicId: 'e1', reason: 'werk-master hung' })
    expect(batonBodies).toHaveLength(1)
    expect(batonBodies[0]).toContain('conv_dead')
    expect(batonBodies[0]).toContain('gen 4')
    expect(batonBodies[0]).toContain('werk-master hung')
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

/**
 * DELETE -- the half of the verb that only the broker can decide.
 *
 * The sentinel already refuses on the run's own status; nothing here re-tests
 * that. What is tested is what the sentinel CANNOT see: a conversation tagged
 * with this epic that is still alive and still writing to the tree the delete is
 * about to move, and the bookkeeping that stops a deleted run coming back.
 */
describe('delete', () => {
  test('an ENDED run with no live seats is deleted, and the reply says where the tree went', async () => {
    run = endedRun()

    const res = await actionDelete(deps(), { project: P, epicId: 'e1' })

    expect(res).toMatchObject({ ok: true })
    expect(sentOps).toContain('delete')
    expect((res as { note: string }).note).toContain('.deleted/e1-')
  })

  /** THE REFUSAL THE SENTINEL CANNOT MAKE. Stricter than `clear`, because this
   *  one moves the artifact those seats are writing to. */
  test('a LIVE seat refuses the delete, and names it', async () => {
    run = endedRun()
    convs = [seat('conv_impl', 'e1')]

    const res = await actionDelete(deps(), { project: P, epicId: 'e1' })

    expect(res).toMatchObject({ ok: false, status: 409 })
    expect((res as { error: string }).error).toContain('conv_impl')
    expect(sentOps).not.toContain('delete')
  })

  test('a DEAD seat does not -- an ended conversation is exactly the normal case', async () => {
    run = endedRun()
    convs = [seat('conv_impl', 'e1', 'ended')]

    expect(await actionDelete(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: true })
  })

  test("another epic's live seat is not this epic's business", async () => {
    run = endedRun()
    convs = [seat('conv_other', 'e2')]

    expect(await actionDelete(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: true })
  })

  test('an epic with no run artifact has nothing to delete', async () => {
    run = null

    expect(await actionDelete(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 409 })
    expect(sentOps).not.toContain('delete')
  })

  test('an unreachable sentinel fails loudly rather than reporting a delete that never happened', async () => {
    run = endedRun()
    getError = 'sentinel offline'

    expect(await actionDelete(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 502 })
    expect(sentOps).not.toContain('delete')
  })

  /**
   * THE BOOKKEEPING IS WHAT MAKES IT STICK. The broker finds runs by grouping
   * CONVERSATIONS, not by reading the disk, and the registry keeps a
   * conversation after it ends -- so a delete that moved the tree and told the
   * broker nothing would leave a phantom the sweep beats every 45s forever.
   */
  test('the run leaves the armed set and gains a tombstone', async () => {
    run = endedRun('paused')
    noteArmedEpic(P, 'e1')

    await actionDelete(deps(), { project: P, epicId: 'e1' })

    expect(listArmedEpics()).toEqual([])
    expect(isDeletedEpic(P, 'e1')).toBe(true)
  })

  /** AFTER the sentinel confirms, never before: a tombstone written for a
   *  refused delete would hide a run that is still very much there. */
  test('a sentinel refusal writes no tombstone and does not un-arm the run', async () => {
    run = endedRun('paused')
    deleteOk = false
    noteArmedEpic(P, 'e1')

    expect(await actionDelete(deps(), { project: P, epicId: 'e1' })).toMatchObject({ ok: false, status: 409 })
    expect(isDeletedEpic(P, 'e1')).toBe(false)
    expect(listArmedEpics()).toHaveLength(1)
  })

  test('the badge is told immediately rather than waiting up to 45s to agree with the click', async () => {
    run = endedRun()

    await actionDelete(deps(), { project: P, epicId: 'e1' })

    expect(published).toBe(1)
  })

  /**
   * CARDS ARE NOT REFUSALS, THEY ARE A NOTICE. A run armed by mistake on an epic
   * with twenty open cards is exactly the case this verb exists for, so open
   * cards must never block it -- but a human deleting a "run" will assume the
   * cards went with it unless the reply says otherwise.
   */
  test('open cards are counted in the reply, not treated as a refusal', async () => {
    run = endedRun()
    cards = [card('c1', 'e1', 'open'), card('c2', 'e1', 'in-progress'), card('c3', 'e1', 'done')]

    const res = await actionDelete(deps(), { project: P, epicId: 'e1' })

    expect(res).toMatchObject({ ok: true })
    const note = (res as { note: string }).note
    expect(note).toContain('3 card(s) were NOT touched')
    expect(note).toContain('2 of them unfinished')
  })

  test('an epic with no cards still says the cards were not touched', async () => {
    run = endedRun()

    expect(((await actionDelete(deps(), { project: P, epicId: 'e1' })) as { note: string }).note).toContain(
      'NOT touched',
    )
  })

  test('the reason travels to the sentinel, which records it in the baton before the move', async () => {
    run = endedRun()
    let sentReason: string | undefined
    configureActionIo({
      sendEpicOp: async (_d, _p, op) => {
        sentReason = op.reason
        return { ok: true, deletedTo: '.deleted/e1-x' } as EpicResult
      },
    })

    await actionDelete(deps(), { project: P, epicId: 'e1', reason: 'armed the wrong card' })

    expect(sentReason).toBe('armed the wrong card')
  })
})
