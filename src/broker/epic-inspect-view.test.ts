import { describe, expect, test } from 'bun:test'
import type { EpicPlan } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation } from '../shared/protocol'
import { epicConversations, toInspectLive, toInspectPlan } from './epic-inspect-view'
import type { EpicGroup } from './epic-sweep'

function card(slug: string, status = 'open', title = `card ${slug}`): ProjectTaskMeta {
  return {
    slug,
    status: status as ProjectTaskMeta['status'],
    title,
    tags: [],
    refs: [],
    created: '',
    mtime: 0,
    bodyPreview: '',
  }
}

function plan(over: Partial<EpicPlan> = {}): EpicPlan {
  return {
    rollup: null,
    dispatch: [],
    verify: [],
    questions: [],
    heldBack: [],
    waitingOnDeps: [],
    unspawnable: [],
    needsRefine: [],
    exhausted: [],
    alreadyRun: [],
    complete: false,
    ...over,
  }
}

function group(over: Partial<EpicGroup> = {}): EpicGroup {
  return {
    epicId: 'e1',
    project: 'claude://s/p',
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    failedLegs: [],
    unspawnable: [],
    convIds: [],
    maxGenSeen: 0,
    ...over,
  }
}

function conv(id: string, epic: Record<string, unknown> | undefined, status = 'active'): Conversation {
  return { id, project: 'claude://s/p', status, ...(epic ? { launchConfig: { epic } } : {}) } as unknown as Conversation
}

describe('toInspectPlan', () => {
  test('every lane survives the projection', () => {
    const out = toInspectPlan(
      plan({
        dispatch: [card('t1')],
        verify: [card('t2', 'in-review')],
        questions: [card('q1')],
        heldBack: [card('t3')],
        waitingOnDeps: [{ card: card('t4'), waitingOn: ['t1', 't2'] }],
      }),
    )
    expect(out.dispatch.map(c => c.id)).toEqual(['t1'])
    expect(out.verify[0]?.status).toBe('in-review')
    expect(out.questions.map(c => c.id)).toEqual(['q1'])
    expect(out.heldBack.map(c => c.id)).toEqual(['t3'])
    expect(out.waitingOnDeps[0]).toEqual({ id: 't4', title: 'card t4', status: 'open', waitingOn: ['t1', 't2'] })
  })

  test('idleReason is carried through -- it is the single most useful field here', () => {
    expect(toInspectPlan(plan({ idleReason: '2 open question(s)' })).idleReason).toBe('2 open question(s)')
  })

  test('no idleReason means work is dispatchable, and the key is absent rather than empty', () => {
    expect(toInspectPlan(plan({ dispatch: [card('t1')] }))).not.toHaveProperty('idleReason')
  })

  test('waitingOn is omitted on cards that are not waiting, so a lane is not full of empty arrays', () => {
    expect(toInspectPlan(plan({ dispatch: [card('t1')] })).dispatch[0]).not.toHaveProperty('waitingOn')
  })

  test('a null rollup reports ZERO children rather than throwing', () => {
    expect(toInspectPlan(plan()).children).toBe(0)
  })
})

describe('epicConversations', () => {
  const isLive = (c: Conversation) => c.status !== 'ended'

  test('only conversations tagged for THIS epic come back', () => {
    const convs = [
      conv('a', { epicId: 'e1', role: 'overseer', gen: 3 }),
      conv('b', { epicId: 'other', role: 'implementer', cardId: 't1', gen: 1 }),
      conv('c', undefined),
    ]
    expect(epicConversations(convs, isLive, 'e1').map(r => r.id)).toEqual(['a'])
  })

  test('role, card and generation survive; liveness is computed, not taken from status alone', () => {
    const convs = [conv('a', { epicId: 'e1', role: 'implementer', cardId: 't5', gen: 6 }, 'ended')]
    expect(epicConversations(convs, isLive, 'e1')[0]).toEqual({
      id: 'a',
      role: 'implementer',
      cardId: 't5',
      gen: 6,
      status: 'ended',
      live: false,
    })
  })

  test('newest generation first -- a dead retry-predecessor must not head the list', () => {
    const convs = [
      conv('old', { epicId: 'e1', role: 'implementer', cardId: 't1', gen: 1 }, 'ended'),
      conv('new', { epicId: 'e1', role: 'implementer', cardId: 't1', gen: 4 }),
    ]
    expect(epicConversations(convs, isLive, 'e1').map(r => r.id)).toEqual(['new', 'old'])
  })

  test('an overseer carries no cardId, and the key is absent rather than undefined', () => {
    const rows = epicConversations([conv('a', { epicId: 'e1', role: 'overseer', gen: 2 })], isLive, 'e1')
    expect(rows[0]).not.toHaveProperty('cardId')
  })
})

describe('toInspectLive', () => {
  const base = { armed: true, unacknowledged: [], runGen: 5, conversations: [] }

  test('the lanes and the armed flag come through', () => {
    const out = toInspectLive({
      ...base,
      group: group({ inFlight: ['t1'], settled: ['t2'], overseerAlive: true, maxGenSeen: 5 }),
    })
    expect(out).toMatchObject({ armed: true, inFlight: ['t1'], settled: ['t2'], overseerAlive: true, maxGenSeen: 5 })
  })

  test('a generation mismatch is PROMOTED to a field -- it used to be a log line nobody read', () => {
    const out = toInspectLive({ ...base, group: group({ maxGenSeen: 9 }), runGen: 5 })
    expect(out.generationMismatch).toContain('tagged gen 9')
  })

  test('agreement means no mismatch key at all, so its presence always means trouble', () => {
    expect(toInspectLive({ ...base, group: group({ maxGenSeen: 5 }), runGen: 5 })).not.toHaveProperty(
      'generationMismatch',
    )
  })

  test('the registry seeing a LOWER generation than run.md is normal and not flagged', () => {
    // A run that just leased is at gen N before anything is tagged with it.
    expect(toInspectLive({ ...base, group: group({ maxGenSeen: 4 }), runGen: 5 })).not.toHaveProperty(
      'generationMismatch',
    )
  })

  /**
   * `runGen: null` is "the run was never read", which is NOT `runGen: 0`. The
   * comparison against 0 is what produced `tagged gen 6 but run.md says 0` on a
   * gen-6 run whose only sin was one timed-out sentinel RPC.
   */
  test('a run that was never READ produces no mismatch -- there is nothing to disagree with', () => {
    expect(toInspectLive({ ...base, group: group({ maxGenSeen: 9 }), runGen: null })).not.toHaveProperty(
      'generationMismatch',
    )
  })

  test('unacknowledged settles are surfaced -- this is what a wake is FOR', () => {
    const out = toInspectLive({ ...base, group: group({ settled: ['t7'] }), unacknowledged: ['t7'] })
    expect(out.unacknowledged).toEqual(['t7'])
  })

  test('the group is copied, not aliased -- an inspect must not hand out mutable engine state', () => {
    const g = group({ inFlight: ['t1'] })
    const out = toInspectLive({ ...base, group: g })
    out.inFlight.push('t2')
    expect(g.inFlight).toEqual(['t1'])
  })
})
