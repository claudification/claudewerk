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
