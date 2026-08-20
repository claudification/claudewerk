import { describe, expect, test } from 'bun:test'
import type { EpicPlan } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicBeatInput, planBeat } from './epic-beat'

function card(slug: string): ProjectTaskMeta {
  return { slug, status: 'open', title: slug, tags: [], refs: [], created: '', mtime: 0, bodyPreview: '' }
}

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: 'now',
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

const EMPTY_PLAN: EpicPlan = {
  rollup: null,
  dispatch: [],
  verify: [],
  questions: [],
  heldBack: [],
  waitingOnDeps: [],
  unspawnable: [],
  complete: false,
}

function beat(over: Partial<EpicBeatInput> = {}, plan: Partial<EpicPlan> = {}, run: Partial<EpicRunSnapshot> = {}) {
  return planBeat({
    run: { ...RUN, ...run },
    plan: { ...EMPTY_PLAN, ...plan },
    inFlight: [],
    overseerAlive: false,
    unacknowledged: [],
    windowOpen: true,
    boardFingerprint: '',
    ...over,
  })
}

const kinds = (b: ReturnType<typeof planBeat>) => b.actions.map(a => a.kind)

describe('planBeat', () => {
  test('every beat explains itself, even an empty one', () => {
    expect(beat().note).not.toBe('')
  })

  test.each(['paused', 'complete', 'aborted'] as const)('a %s run does nothing at all', status => {
    const b = beat({ unacknowledged: ['t1'] }, { dispatch: [card('t2')] }, { status })
    expect(b.actions).toEqual([])
  })

  test('a live overseer holds the beat -- nothing dispatches underneath it', () => {
    const b = beat({ overseerAlive: true }, { dispatch: [card('t1')] })
    expect(b.actions).toEqual([])
    expect(b.note).toContain('overseer alive')
  })

  test('an unacknowledged settle outranks dispatching more work', () => {
    const b = beat({ unacknowledged: ['t1'] }, { dispatch: [card('t2')] })
    expect(kinds(b)).toEqual(['wake-overseer'])
    expect(b.actions[0]).toMatchObject({ expectGen: 3, reason: 'card-settled' })
  })

  test('the wake carries the CURRENT generation, which is what makes it idempotent', () => {
    const b = beat({ unacknowledged: ['t1'] }, {}, { gen: 9 })
    expect(b.actions[0]).toMatchObject({ kind: 'wake-overseer', expectGen: 9 })
  })

  test('an open question wakes the overseer rather than dispatching around it', () => {
    const b = beat({}, { questions: [card('q1')], dispatch: [card('t1')] })
    expect(kinds(b)).toEqual(['wake-overseer'])
  })

  test('ready cards dispatch, in-review cards verify, both in one beat', () => {
    const b = beat({}, { dispatch: [card('t1'), card('t2')], verify: [card('t3')] })
    expect(kinds(b)).toEqual(['verify', 'dispatch', 'dispatch'])
  })

  test('the generation ceiling parks the run before it dispatches anything', () => {
    const b = beat({}, { dispatch: [card('t1')] }, { gen: 40, maxGens: 40 })
    expect(kinds(b)).toEqual(['park'])
    expect(b.actions[0]).toMatchObject({ reason: expect.stringContaining('thrashing') })
  })

  test('all children terminal completes the run', () => {
    expect(kinds(beat({}, { complete: true }))).toEqual(['complete'])
  })

  test('work in flight just waits -- no wake, no park', () => {
    const b = beat({ inFlight: ['t1'] })
    expect(b.actions).toEqual([])
    expect(b.note).toContain('in flight')
  })

  test('the FIRST dry generation wakes the overseer to replan', () => {
    const b = beat({}, { idleReason: 'nothing ready' }, { dryGens: 0 })
    expect(kinds(b)).toEqual(['wake-overseer'])
  })

  test('the SECOND dry generation parks, carrying the reason forward', () => {
    const b = beat({}, { idleReason: 'nothing ready: t3 <- t2' }, { dryGens: 1 })
    expect(kinds(b)).toEqual(['park'])
    expect(b.actions[0]).toMatchObject({ reason: expect.stringContaining('t3 <- t2') })
  })
})

describe('cadence is a mode on one engine', () => {
  test('cadence=now ignores the clock', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: 'now' })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('cadence=window holds dispatch until the window opens', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: 'window' })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('window is closed')
  })

  test('a closed window still lets a verdict land -- judging is not night work', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')], verify: [card('t2')] }, { cadence: 'window' })
    expect(kinds(b)).toEqual(['verify'])
  })

  test('cadence=window dispatches normally once the window is open', () => {
    const b = beat({ windowOpen: true }, { dispatch: [card('t1')] }, { cadence: 'window' })
    expect(kinds(b)).toEqual(['dispatch'])
  })
})

/**
 * GENERATION 0. The pass exists because readiness is arithmetic over `depends_on`
 * and nothing else looks at it, so the DAG is only as good as the edges somebody
 * remembered to declare. Racing it would defeat the point entirely: the engine
 * would dispatch against the graph the planner is still in the middle of fixing.
 */
describe('the planning generation', () => {
  const OWED = { plan: true, planned: false } as Partial<EpicRunSnapshot>

  test('is dispatched before anything else, even with cards ready', () => {
    const b = beat({ boardFingerprint: 'a' }, { dispatch: [card('t1')], verify: [card('t2')] }, OWED)
    expect(kinds(b)).toEqual(['plan'])
  })

  test('outranks an unacknowledged settle and an open question', () => {
    // Both of these normally win over dispatch. Planning wins over both, because
    // until it runs the board those decisions are made from is unfinished.
    const b = beat({ boardFingerprint: 'a', unacknowledged: ['t1'] }, { questions: [card('q1')] }, OWED)
    expect(kinds(b)).toEqual(['plan'])
  })

  test('carries the fingerprint it must be judged against', () => {
    const b = beat({ boardFingerprint: 'before' }, {}, OWED)
    expect(b.actions[0]).toEqual({ kind: 'plan', baseline: 'before' })
  })

  test('does not run twice -- a baseline on the run means it is already in flight', () => {
    const b = beat({ boardFingerprint: 'before' }, {}, { ...OWED, planBaseline: 'before' })
    expect(kinds(b)).toEqual(['plan-accept'])
  })

  test('accepts a plan that left the board alone, and work proceeds', () => {
    const b = beat({ boardFingerprint: 'same' }, {}, { ...OWED, planBaseline: 'same' })
    expect(kinds(b)).toEqual(['plan-accept'])
    expect(b.note).toContain('unchanged')
  })

  test('CHECKPOINTS when the planner rewrote the board -- nothing dispatches first', () => {
    const b = beat({ boardFingerprint: 'after' }, { dispatch: [card('t1')] }, { ...OWED, planBaseline: 'before' })
    expect(kinds(b)).toEqual(['plan-checkpoint'])
    expect(b.actions[0]).toEqual({ kind: 'plan-checkpoint', before: 'before', after: 'after' })
  })

  test('is skipped entirely once it has run -- a RESUME never re-plans', () => {
    const b = beat({ boardFingerprint: 'x' }, { dispatch: [card('t1')] }, { plan: true, planned: true })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('is skipped when the run was armed with planning off', () => {
    const b = beat({ boardFingerprint: 'x' }, { dispatch: [card('t1')] }, { plan: false, planned: false })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('never pre-empts a live overseer -- the planner sits in that same seat', () => {
    const b = beat({ boardFingerprint: 'a', overseerAlive: true }, {}, OWED)
    expect(kinds(b)).toEqual([])
  })

  test('does not resurrect a paused run', () => {
    const b = beat({ boardFingerprint: 'a' }, {}, { ...OWED, status: 'paused' })
    expect(kinds(b)).toEqual([])
  })
})

/**
 * THE BRAKE THAT WAS NEVER WIRED. `dryGens` is read as the "second consecutive
 * dry generation parks the run" valve and reported in the overseer's briefing,
 * but nothing ever incremented it -- so it sat at 0 forever, the park was
 * unreachable, and the only ceiling on a thrashing run was maxGens: 40. That is
 * 40 billed overseer generations before anything stops.
 */
describe('dryGens -- counting the generations that found nothing', () => {
  test('a dry generation asks for the counter to go up', () => {
    const out = beat({}, {}, { dryGens: 0 })
    expect(out.dryGens).toBe(1)
    expect(kinds(out)).toEqual(['wake-overseer'])
  })

  test('and says which dry generation it is, so a log reader sees the streak', () => {
    expect(beat({}, {}, { dryGens: 0 }).note).toContain('dry generation 1')
  })

  test('the SECOND consecutive dry generation parks the run instead of waking again', () => {
    expect(kinds(beat({}, {}, { dryGens: 1 }))).toEqual(['park'])
  })

  /**
   * CONSECUTIVE is the whole point. A run that alternates dry and productive
   * generations is making progress and must never accumulate its way into a
   * park.
   */
  test('a beat that dispatches CLEARS the streak', () => {
    const out = beat({}, { dispatch: [card('t1')] }, { dryGens: 1 })
    expect(out.dryGens).toBe(0)
  })

  test('a dispatching beat on an already-clear counter asks for no write at all', () => {
    expect(beat({}, { dispatch: [card('t1')] }, { dryGens: 0 }).dryGens).toBeUndefined()
  })

  test('a beat that is merely WAITING on in-flight work is not dry', () => {
    expect(beat({ inFlight: ['t1'] }, {}, { dryGens: 0 }).dryGens).toBeUndefined()
  })
})
