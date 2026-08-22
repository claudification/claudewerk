import { describe, expect, test } from 'bun:test'
import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { EpicPlan } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicBeatInput, planBeat } from './epic-beat'
import type { QueueVerdict } from './epic-queue'

function card(slug: string): ProjectTaskMeta {
  return { slug, status: 'open', title: slug, tags: [], refs: [], created: '', mtime: 0, bodyPreview: '' }
}

/** The wall clock every test below reads from, so `nowMs` is never a real clock. */
const T0 = Date.parse('2026-08-21T00:00:00.000Z')
const at = (minutes: number) => T0 + minutes * 60_000

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  maxUsd: 100,
  maxWallClockMinutes: 480,
  spentUsd: 0,
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
  needsRefine: [],
  exhausted: [],
  alreadyRun: [],
  complete: false,
}

function beat(over: Partial<EpicBeatInput> = {}, plan: Partial<EpicPlan> = {}, run: Partial<EpicRunSnapshot> = {}) {
  return planBeat({
    run: { ...RUN, ...run },
    // THE GENERATION IS ITS OWN INPUT, off the lease -- the run artifact does not
    // carry one. Defaulted from the run fixture's `gen` so a test that wants a
    // specific generation can still say `{ gen: 40 }` in either bag and mean the
    // same thing; `over` wins, as it does for every other field.
    gen: run.gen ?? RUN.gen,
    plan: { ...EMPTY_PLAN, ...plan },
    inFlight: [],
    werkMasterAlive: false,
    unacknowledged: [],
    windowOpen: true,
    boardFingerprint: '',
    spentUsd: 0,
    nowMs: T0,
    ...over,
  })
}

const kinds = (b: ReturnType<typeof planBeat>) => b.actions.map(a => a.kind)

/** What `epic-queue.ts` hands a beat that must wait its turn. The exact fold that
 *  produces it is that module's own test; here it is an input. */
const BLOCKED: QueueVerdict = {
  blocked: true,
  position: 2,
  total: 3,
  behind: ['epic-morning-report'],
  reason: 'queued, position 2 of 3, behind epic-morning-report (waiting 4m)',
}

const FREE: QueueVerdict = { blocked: false, position: 1, total: 1, behind: [], reason: null }

describe('planBeat', () => {
  test('every beat explains itself, even an empty one', () => {
    expect(beat().note).not.toBe('')
  })

  test.each(['paused', 'complete', 'aborted'] as const)('a %s run does nothing at all', status => {
    const b = beat({ unacknowledged: ['t1'] }, { dispatch: [card('t2')] }, { status })
    expect(b.actions).toEqual([])
  })

  test('a live werk-master holds the beat -- nothing dispatches underneath it', () => {
    const b = beat({ werkMasterAlive: true }, { dispatch: [card('t1')] })
    expect(b.actions).toEqual([])
    expect(b.note).toContain('werk-master alive')
  })

  /**
   * THE REPLACEMENT GENERATION. `werkMasterLost` is what the fold hands the beat
   * once it has stopped believing a supervisor whose end was never recorded --
   * see `epic-sweep.ts` `lostWerkMaster`.
   */
  describe('a reaped werk-master wakes a replacement, and the generation says so', () => {
    test('the beat after the reap wakes, rather than dispatching under a corpse', () => {
      const b = beat({ werkMasterLost: true }, { dispatch: [card('t1')] })
      expect(kinds(b)).toEqual(['wake-werk-master'])
      expect(b.actions[0]).toMatchObject({ expectGen: 3, reason: 'werk-master-lost' })
    })

    /**
     * THE WHOLE POINT OF A SEPARATE REASON. Both branches wake exactly one
     * werk-master with the same settled list in its prompt, so the only thing the
     * ordering decides is which fact the generation is NAMED after -- and a
     * generation that replaced a corpse is not the same event as one that
     * followed a finished turn.
     */
    test('and outranks a settle, which would otherwise name the generation `card-settled`', () => {
      const b = beat({ werkMasterLost: true, unacknowledged: ['t1'] })
      expect(b.actions[0]).toMatchObject({ reason: 'werk-master-lost' })
      expect(b.note).toContain('unacknowledged settle')
    })

    test('the note says REAPED, so the broker log is not another `werk-master alive` line', () => {
      expect(beat({ werkMasterLost: true }).note).toContain('REAPED')
    })

    /** A live werk-master is still a live werk-master: the reap concerns a DIFFERENT
     *  conversation (an ex-holder), and dispatching under the live one is the
     *  bug `guardBeat`'s hold exists to prevent. */
    test('a live werk-master still holds the beat even when some other seat was reaped', () => {
      const b = beat({ werkMasterLost: true, werkMasterAlive: true }, { dispatch: [card('t1')] })
      expect(b.actions).toEqual([])
      expect(b.note).toContain('werk-master alive')
    })

    /** A werk-planner sits in the werk-master seat, so it is reaped like any other -- but
     *  what the run owes is a RESOLVED planning generation, decided from the
     *  board fingerprint, not a second werk-planner. */
    test('a run still owed a planning generation resolves that first', () => {
      const b = beat(
        { werkMasterLost: true, boardFingerprint: 'fp' },
        {},
        { plan: true, planned: false, planBaseline: 'fp' },
      )
      expect(kinds(b)).toEqual(['plan-accept'])
    })

    test('the ceilings still park ahead of it -- a dead werk-master is not a reason to keep spending', () => {
      const b = beat({ werkMasterLost: true }, {}, { gen: 40, maxGens: 40 })
      expect(kinds(b)).toEqual(['park'])
    })

    test('absent means no reap, which is every caller that never wired a reaper up', () => {
      expect(beat({}, { dispatch: [card('t1')] }).actions.map(a => a.kind)).toEqual(['dispatch'])
    })
  })

  test('an unacknowledged settle outranks dispatching more work', () => {
    const b = beat({ unacknowledged: ['t1'] }, { dispatch: [card('t2')] })
    expect(kinds(b)).toEqual(['wake-werk-master'])
    expect(b.actions[0]).toMatchObject({ expectGen: 3, reason: 'card-settled' })
  })

  test('the wake carries the CURRENT generation, which is what makes it idempotent', () => {
    const b = beat({ unacknowledged: ['t1'] }, {}, { gen: 9 })
    expect(b.actions[0]).toMatchObject({ kind: 'wake-werk-master', expectGen: 9 })
  })

  test('an open question wakes the werk-master rather than dispatching around it', () => {
    const b = beat({}, { questions: [card('q1')], dispatch: [card('t1')] })
    expect(kinds(b)).toEqual(['wake-werk-master'])
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

  test('the FIRST dry generation wakes the werk-master to replan', () => {
    const b = beat({}, { idleReason: 'nothing ready' }, { dryGens: 0 })
    expect(kinds(b)).toEqual(['wake-werk-master'])
  })

  test('the SECOND dry generation parks, carrying the reason forward', () => {
    const b = beat({}, { idleReason: 'nothing ready: t3 <- t2' }, { dryGens: 1 })
    expect(kinds(b)).toEqual(['park'])
    expect(b.actions[0]).toMatchObject({ reason: expect.stringContaining('t3 <- t2') })
  })
})

/**
 * THE LEASE HAS A TTL AND THE BEAT NOW ASKS ABOUT IT.
 *
 * `evaluateLease` has presumed a holder dead at `LEASE_STALE_MS` since the day it
 * was written, and nothing ever put the question to it: `guardBeat` returned on
 * bare liveness, so every wake -- the only thing that reaches the CAS -- sat below
 * the line that never ran. On 2026-08-20 a werk-master blocked in an `until ...
 * sleep` Bash loop kept its agent-host socket, emitted no events, was therefore
 * un-reapable (`seatAbandoned` requires NO socket), and held the run for the life
 * of the broker: 13+ consecutive beats of `werk-master alive at gen 14; holding the
 * beat` with three cards ready and zero in flight.
 *
 * The TTL here and the CAS's are THE SAME CONSTANT on purpose. A shorter one here
 * would let the beat send a wake the CAS then refuses, which is the same freeze
 * with a busier log.
 */
describe('a stale lease stops holding the beat', () => {
  const heldFor = (ms: number) => new Date(T0 - ms).toISOString()
  const WEDGED = { werkMasterAlive: true, leaseAt: heldFor(LEASE_STALE_MS + 60_000) }

  test('a live werk-master past the TTL no longer withholds dispatch', () => {
    const b = beat(WEDGED, { dispatch: [card('t1')] })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('and the note says STALE, with the age and the TTL it passed', () => {
    const b = beat(WEDGED, { dispatch: [card('t1')] })
    expect(b.note).toContain('STALE')
    expect(b.note).toContain('11m')
    expect(b.note).toContain('NOT holding the beat')
  })

  /** Nothing to dispatch is the case that actually reaches the CAS: the wake goes
   *  out under the same generation the stale holder is sitting on, and
   *  `evaluateLease` grants over it because `holderAlive && !isStale` is false. */
  test('with nothing to dispatch, the wake goes out so the CAS can replace the holder', () => {
    const b = beat(WEDGED, { idleReason: 'nothing ready' })
    expect(kinds(b)).toEqual(['wake-werk-master'])
    expect(b.actions[0]).toMatchObject({ expectGen: 3 })
    expect(b.note).toContain('STALE')
  })

  test('a werk-master INSIDE the TTL still holds, and the hold says how long it has held', () => {
    const b = beat({ werkMasterAlive: true, leaseAt: heldFor(4 * 60_000) }, { dispatch: [card('t1')] })
    expect(b.actions).toEqual([])
    expect(b.note).toContain('WORKING')
    expect(b.note).toContain('4m')
  })

  /** Strictly greater, matching `isStale`. A beat that broke a grip one tick
   *  earlier than the CAS would send a wake the CAS refuses. */
  test('exactly at the TTL is not yet stale', () => {
    expect(
      beat({ werkMasterAlive: true, leaseAt: heldFor(LEASE_STALE_MS) }, { dispatch: [card('t1')] }).actions,
    ).toEqual([])
  })

  /** The OPPOSITE reading from `isStale`, deliberately: no evidence about the
   *  grip's age is not evidence that it is old, and the safe answer to "may I
   *  dispatch under a live supervisor" is no. */
  test.each([
    ['absent', undefined],
    ['unparseable', 'not-a-date'],
  ])('a %s lease timestamp holds, rather than breaking a grip on no evidence', (_label, leaseAt) => {
    const b = beat({ werkMasterAlive: true, ...(leaseAt ? { leaseAt } : {}) }, { dispatch: [card('t1')] })
    expect(b.actions).toEqual([])
    expect(b.note).toContain('lease age unknown')
  })

  /** The ceilings outrank the lease. A run over budget parks whatever the grip
   *  says, and the park's note must not claim a lease was let go. */
  test('a run over its generation ceiling parks, and says nothing about the lease', () => {
    const b = beat({ ...WEDGED, gen: 40 }, { dispatch: [card('t1')] }, { maxGens: 40 })
    expect(kinds(b)).toEqual(['park'])
    expect(b.note).not.toContain('STALE')
  })
})

describe('cadence is a mode on one engine', () => {
  test('cadence=now ignores the clock', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['now'] })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('cadence=window holds dispatch until the window opens', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['window'] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('window is closed')
  })

  test('a closed window still lets a verdict land -- judging is not night work', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')], verify: [card('t2')] }, { cadence: ['window'] })
    expect(kinds(b)).toEqual(['verify'])
  })

  test('cadence=window dispatches normally once the window is open', () => {
    const b = beat({ windowOpen: true }, { dispatch: [card('t1')] }, { cadence: ['window'] })
    expect(kinds(b)).toEqual(['dispatch'])
  })
})

/**
 * GENERATION 0. The pass exists because readiness is arithmetic over `depends_on`
 * and nothing else looks at it, so the DAG is only as good as the edges somebody
 * remembered to declare. Racing it would defeat the point entirely: the engine
 * would dispatch against the graph the werk-planner is still in the middle of fixing.
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

  test('CHECKPOINTS when the werk-planner rewrote the board -- nothing dispatches first', () => {
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

  test('never pre-empts a live werk-master -- the werk-planner sits in that same seat', () => {
    const b = beat({ boardFingerprint: 'a', werkMasterAlive: true }, {}, OWED)
    expect(kinds(b)).toEqual([])
  })

  test('does not resurrect a paused run', () => {
    const b = beat({ boardFingerprint: 'a' }, {}, { ...OWED, status: 'paused' })
    expect(kinds(b)).toEqual([])
  })
})

/**
 * THE BRAKE THAT WAS NEVER WIRED. `dryGens` is read as the "second consecutive
 * dry generation parks the run" valve and reported in the werk-master's briefing,
 * but nothing ever incremented it -- so it sat at 0 forever, the park was
 * unreachable, and the only ceiling on a thrashing run was maxGens: 40. That is
 * 40 billed werk-master generations before anything stops.
 */
describe('dryGens -- counting the generations that found nothing', () => {
  test('a dry generation asks for the counter to go up', () => {
    const out = beat({}, {}, { dryGens: 0 })
    expect(out.patch?.dryGens).toBe(1)
    expect(kinds(out)).toEqual(['wake-werk-master'])
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
    expect(out.patch?.dryGens).toBe(0)
  })

  test('a dispatching beat on an already-clear counter asks for no write at all', () => {
    expect(beat({}, { dispatch: [card('t1')] }, { dryGens: 0 }).patch?.dryGens).toBeUndefined()
  })

  test('a beat that is merely WAITING on in-flight work is not dry', () => {
    expect(beat({ inFlight: ['t1'] }, {}, { dryGens: 0 }).patch?.dryGens).toBeUndefined()
  })
})

/**
 * THE RUN CAPS. `maxGens` bounds how many times the WERK-MASTER THINKS and bounds
 * nothing about what the seats underneath it burn: one generation with three
 * werk-workers chewing an XL card for two hours costs more than thirty dry ones.
 * On 2026-08-19, the day THE WALL II ran, this project billed $2,481 in one
 * calendar day and no cap of any kind was involved in stopping it.
 *
 * So the acceptance bar is not "the field exists" -- it is that the run STOPS.
 * These are the tests that were written before the caps were.
 */
describe('the run caps -- dollars and wall clock', () => {
  const RUNNING = { startedAt: '2026-08-21T00:00:00.000Z' } as Partial<EpicRunSnapshot>

  test('spend under the ceiling dispatches exactly as before', () => {
    const b = beat({ spentUsd: 24.99 }, { dispatch: [card('t1')] }, { maxUsd: 25 })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('spend AT the ceiling parks the run before it dispatches anything', () => {
    const b = beat({ spentUsd: 25 }, { dispatch: [card('t1')] }, { maxUsd: 25 })
    expect(kinds(b)).toEqual(['park'])
  })

  test('the park says WHICH cap tripped and by how much -- never a silent stop', () => {
    const b = beat({ spentUsd: 31.4 }, { dispatch: [card('t1')] }, { maxUsd: 25 })
    const reason = (b.actions[0] as { reason: string }).reason
    expect(reason).toContain('$31.40')
    expect(reason).toContain('$25.00')
    expect(b.note).toContain('spend ceiling')
  })

  test('wall clock under the ceiling dispatches exactly as before', () => {
    const b = beat({ nowMs: at(59) }, { dispatch: [card('t1')] }, { ...RUNNING, maxWallClockMinutes: 60 })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('wall clock AT the ceiling parks the run', () => {
    const b = beat({ nowMs: at(60) }, { dispatch: [card('t1')] }, { ...RUNNING, maxWallClockMinutes: 60 })
    expect(kinds(b)).toEqual(['park'])
    expect(b.actions[0]).toMatchObject({ reason: expect.stringContaining('60 minute') })
    expect(b.note).toContain('wall clock')
  })

  /** The clock has not started, so there is nothing to be over. A run armed for
   *  a night window sits here for hours before its first dispatch is allowed. */
  test('a run whose clock has never started cannot trip the wall-clock cap', () => {
    const b = beat({ nowMs: at(10_000) }, { dispatch: [card('t1')] }, { maxWallClockMinutes: 60 })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  /** An escape hatch that has to be TYPED. Absent is the default, not infinity. */
  test.each(['maxUsd', 'maxWallClockMinutes'] as const)('%s: 0 disarms that one cap deliberately', field => {
    const b = beat(
      { spentUsd: 9_999, nowMs: at(10_000) },
      { dispatch: [card('t1')] },
      { ...RUNNING, maxUsd: 0, maxWallClockMinutes: 0, [field]: 0 },
    )
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('a cap outranks an unacknowledged settle -- an over-budget run wakes nobody', () => {
    const b = beat({ spentUsd: 99, unacknowledged: ['t1'] }, {}, { maxUsd: 25 })
    expect(kinds(b)).toEqual(['park'])
  })

  test('a cap outranks the planning generation too', () => {
    const b = beat({ spentUsd: 99, boardFingerprint: 'a' }, {}, { maxUsd: 25, plan: true, planned: false })
    expect(kinds(b)).toEqual(['park'])
  })

  test('a terminal run is still touched by nothing, cap or no cap', () => {
    const b = beat({ spentUsd: 99 }, { dispatch: [card('t1')] }, { maxUsd: 25, status: 'paused' })
    expect(b.actions).toEqual([])
    expect(b.patch).toBeUndefined()
  })

  /** Deterministic order when two ceilings are over at once: money first,
   *  because money is the thing actually being lost. */
  test('dollars are reported ahead of wall clock when both have tripped', () => {
    const b = beat(
      { spentUsd: 99, nowMs: at(600) },
      {},
      { ...RUNNING, maxUsd: 25, maxWallClockMinutes: 60, gen: 40, maxGens: 40 },
    )
    expect(b.note).toContain('spend ceiling')
  })
})

/**
 * THE LEDGER THE CAPS ARE READ FROM. Cumulative spend is folded by the executor
 * and carried here, so this file stays pure and the executor stays the only
 * writer -- the rule `b766b75e` established after `dryGens` was read every beat
 * and never once written.
 */
describe('spentUsd -- sticky, and never cleared by a good beat', () => {
  test('a fresh fold above the stored figure asks for the write', () => {
    expect(beat({ spentUsd: 12.5 }, {}, { spentUsd: 0 }).patch?.spentUsd).toBe(12.5)
  })

  test('an unchanged figure asks for no write at all', () => {
    expect(beat({ spentUsd: 12.5 }, {}, { spentUsd: 12.5 }).patch?.spentUsd).toBeUndefined()
  })

  /**
   * THE DIFFERENCE FROM THE DRY STREAK, stated as a test so the next reader does
   * not "fix" it. `dryGens` counts CONSECUTIVE empty generations and a productive
   * beat clears it. Spend is cumulative: it never decreases and no beat, however
   * productive, is allowed to zero it.
   */
  test('a beat that dispatches clears the dry streak and leaves the spend alone', () => {
    const out = beat({ spentUsd: 12.5 }, { dispatch: [card('t1')] }, { dryGens: 1, spentUsd: 0 })
    expect(out.patch).toMatchObject({ dryGens: 0, spentUsd: 12.5 })
  })
})

/**
 * WHEN THE CLOCK STARTS. Not when the run is armed: a `window` run armed at noon
 * may not dispatch until the night window opens, and a clock started at arming
 * would spend that whole wait burning a budget the run was never allowed to use.
 * It starts on the first beat the run is actually permitted to work.
 */
describe('startedAt -- the wall clock starts when the run can work', () => {
  test('the first beat that may dispatch stamps it', () => {
    expect(beat({ nowMs: T0 }, { dispatch: [card('t1')] }).patch?.startedAt).toBe('2026-08-21T00:00:00.000Z')
  })

  test('a window run whose window is shut does NOT start the clock', () => {
    const b = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['window'] })
    expect(b.patch?.startedAt).toBeUndefined()
  })

  test('an already-stamped run is not re-stamped', () => {
    const b = beat({ nowMs: at(5) }, {}, { startedAt: '2026-08-21T00:00:00.000Z' })
    expect(b.patch?.startedAt).toBeUndefined()
  })

  /**
   * THE SAME RULE, FOR THE QUEUE GATE -- and here it is doing double duty. A
   * queued run that has not been permitted to dispatch must not burn its
   * wall-clock budget waiting its turn, AND `startedAt` is what `epic-queue.ts`
   * reads back as "this run has entered and now holds the runner". A stamp while
   * blocked would both start the wrong clock and hand the runner to an epic that
   * had not taken it.
   */
  test('a queued run that is still waiting does NOT start the clock', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1')] }, { cadence: ['queue'] })
    expect(b.patch?.startedAt).toBeUndefined()
  })
})

/**
 * THE QUEUE GATE, AT THE BEAT.
 *
 * The cross-epic arithmetic lives in `epic-queue.ts` and is tested there; what
 * these pin is the half a beat owns -- that a blocked verdict withholds DISPATCH
 * and nothing else, that it never counts as a dry generation, and that it
 * composes with the window rather than replacing it.
 */
describe('when=queue', () => {
  test('a blocked epic dispatches nothing, and says where it is in the queue', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1'), card('t2')] }, { cadence: ['queue'] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('position 2 of 3')
    expect(b.note).toContain('epic-morning-report')
  })

  test('it dispatches on the first beat after the other epic goes idle', () => {
    const b = beat({ queue: FREE }, { dispatch: [card('t1')] }, { cadence: ['queue'] })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  /**
   * A QUEUED EPIC IS EXCLUDED FROM THE SEAT RESERVE, stated at the only layer
   * that exists today: blocked means ZERO seats, however much room the
   * concurrency ceiling has and however ready its cards are. When
   * `runner-seat-pool-and-reserve` lands its floor of "every armed epic with
   * ready work is guaranteed a seat", this is the case that must NOT get one --
   * an epic guaranteed a seat is not queued at all. That card's tests own the
   * other half of this constraint.
   */
  test('no seat is granted to a blocked epic, however ready its board is', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1'), card('t2'), card('t3')] }, { cadence: ['queue'] })
    expect(b.actions).toEqual([])
  })

  test('a blocked beat is NOT a dry generation -- waiting is not thrashing', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1')] }, { cadence: ['queue'], dryGens: 1 })
    expect(kinds(b)).toEqual([])
    expect(b.patch?.dryGens).toBeUndefined()
  })

  test('a verdict still lands while the gate holds -- judging is what drains the runner', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1')], verify: [card('t2')] }, { cadence: ['queue'] })
    expect(kinds(b)).toEqual(['verify'])
  })

  /**
   * THE OTHER DIRECTION. A run on no queue at all is held while a queued one
   * holds the runner -- without this half, `queue` would be a promise the engine
   * breaks on the very next beat.
   */
  test('an epic on no queue is held while a queued one holds the runner', () => {
    const held = { ...BLOCKED, position: 0, total: 1, heldBy: 'epic-project-runner', reason: 'held: ...' }
    const b = beat({ queue: held }, { dispatch: [card('t1')] }, { cadence: ['now'] })
    expect(kinds(b)).toEqual([])
  })

  test('window and queue COMPOSE -- both gates must pass, and the note says both', () => {
    const b = beat({ windowOpen: false, queue: BLOCKED }, { dispatch: [card('t1')] }, { cadence: ['window', 'queue'] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('window is closed')
    expect(b.note).toContain('position 2 of 3')

    const open = beat(
      { windowOpen: true, queue: BLOCKED },
      { dispatch: [card('t1')] },
      { cadence: ['window', 'queue'] },
    )
    expect(kinds(open)).toEqual([])

    const both = beat({ windowOpen: true, queue: FREE }, { dispatch: [card('t1')] }, { cadence: ['window', 'queue'] })
    expect(kinds(both)).toEqual(['dispatch'])
  })
})

/**
 * THE APPOINTMENT GATE, AT THE BEAT -- `when=at:<iso>`.
 *
 * The codec is `epic-when.test.ts`'s; what these pin is the half a beat owns:
 * that an appointment in the future withholds DISPATCH and nothing else, that it
 * costs no wall clock, that it never counts as a dry generation, that it composes
 * with the other two gates, and that a FORCED beat -- and only a forced beat --
 * walks through it and says that it did.
 *
 * `T0` is 2026-08-21T00:00:00Z, so `SOON` (02:00+07:00 on the 21st, = 19:00Z on
 * the 20th) is in the PAST and `LATER` is four hours out.
 */
describe('when=<instant> -- an appointment', () => {
  /** 2026-08-21T04:00:00Z, four hours after T0. */
  const LATER = 'at:2026-08-21T11:00:00+07:00'
  /** 2026-08-20T19:00:00Z -- five hours BEFORE T0. */
  const PASSED = 'at:2026-08-21T02:00:00+07:00'

  test('an armed run whose appointment is in the future dispatches NOTHING', () => {
    const b = beat({}, { dispatch: [card('t1'), card('t2')] }, { cadence: [LATER], status: 'armed' })
    expect(b.actions).toEqual([])
  })

  /** THE COUNTDOWN, EVERY TICK. A run waiting on the clock has nothing in flight
   *  and no fresh beat, which is byte-for-byte what a dead run looks like -- the
   *  same reason the restart quarantine logs one on every held tick. */
  test('it logs what it is waiting for and how long is left, and never a bare time', () => {
    const b = beat({}, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(b.note).toContain('waiting until 2026-08-21T11:00:00+07:00')
    expect(b.note).toContain('in 4 hours')
    expect(b.note).toContain('1 card(s) waiting')
  })

  test('it dispatches on the FIRST beat after the appointment passes', () => {
    const b = beat({ nowMs: Date.parse('2026-08-21T04:00:00.000Z') }, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('an appointment already in the past is no gate at all', () => {
    expect(kinds(beat({}, { dispatch: [card('t1')] }, { cadence: [PASSED] }))).toEqual(['dispatch'])
  })

  /**
   * THE MOST LIKELY PLACE FOR THIS GATE TO INTRODUCE A SILENT BUG, and the card
   * said so: a run that burned its wall-clock budget while waiting would park
   * itself before it ever dispatched. `startedAt` is the whole answer -- it means
   * "the first beat this run was PERMITTED to dispatch", the appointment withholds
   * that permission, and `elapsedRunMinutes` returns null without it.
   */
  test('the wall clock does NOT start while the appointment is still ahead', () => {
    const b = beat({}, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(b.patch?.startedAt).toBeUndefined()
  })

  test('and so the wall-clock ceiling cannot trip on a run that has only ever waited', () => {
    // One minute of budget, armed hours ago, waiting on an appointment: with a
    // clock that started at ARMING this would park before dispatching anything.
    const b = beat(
      { nowMs: Date.parse('2026-08-21T03:59:00.000Z') },
      { dispatch: [card('t1')] },
      { cadence: [LATER], maxWallClockMinutes: 1, created: '2026-08-20T00:00:00.000Z' },
    )
    expect(kinds(b)).toEqual([])
    expect(b.note).not.toContain('wall clock ceiling')
  })

  test('the clock starts on the beat the appointment lets it through', () => {
    const b = beat({ nowMs: Date.parse('2026-08-21T04:00:00.000Z') }, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(b.patch?.startedAt).toBe('2026-08-21T04:00:00.000Z')
  })

  test('waiting is not thrashing -- a held beat is NOT a dry generation', () => {
    const b = beat({}, { dispatch: [card('t1')] }, { cadence: [LATER], dryGens: 1 })
    expect(kinds(b)).toEqual([])
    expect(b.patch?.dryGens).toBeUndefined()
  })

  test('a verdict still lands while the appointment holds -- judging is not scheduled work', () => {
    const b = beat({}, { dispatch: [card('t1')], verify: [card('t2')] }, { cadence: [LATER] })
    expect(kinds(b)).toEqual(['verify'])
  })

  test('window and the appointment COMPOSE -- both must pass on the same beat', () => {
    const shut = beat({ windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['window', PASSED] })
    expect(kinds(shut)).toEqual([])
    expect(shut.note).toContain('window is closed')

    const early = beat({ windowOpen: true }, { dispatch: [card('t1')] }, { cadence: ['window', LATER] })
    expect(kinds(early)).toEqual([])
    expect(early.note).toContain('waiting until')

    const both = beat({ windowOpen: true }, { dispatch: [card('t1')] }, { cadence: ['window', PASSED] })
    expect(kinds(both)).toEqual(['dispatch'])
  })

  test('queue and the appointment COMPOSE, and one line names both', () => {
    const b = beat({ queue: BLOCKED }, { dispatch: [card('t1')] }, { cadence: ['queue', LATER] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('position 2 of 3')
    expect(b.note).toContain('waiting until')

    const turn = beat({ queue: FREE }, { dispatch: [card('t1')] }, { cadence: ['queue', PASSED] })
    expect(kinds(turn)).toEqual(['dispatch'])
  })
})

/**
 * BEAT NOW vs THE GATES.
 *
 * An explicit beat overrides the APPOINTMENT and nothing else. The appointment is
 * one person's note about when to begin, so the person pressing the button is the
 * one who set it; `window` is a project policy about when the box may be busy and
 * `queue` is a promise made to every OTHER epic. A back door around either is a
 * back door around the only thing they guarantee.
 */
describe('a forced beat and the `when` axis', () => {
  const LATER = 'at:2026-08-21T11:00:00+07:00'

  test('fires an appointment early', () => {
    const b = beat({ forced: true }, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(kinds(b)).toEqual(['dispatch'])
  })

  test('and RECORDS that it did, so the baton does not read as a gate that failed', () => {
    const b = beat({ forced: true }, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(b.note).toContain('OVERRIDDEN by an explicit beat')
    expect(b.note).toContain('waiting until 2026-08-21T11:00:00+07:00')
  })

  test('says so even when the beat it forced found nothing to do', () => {
    const b = beat({ forced: true, inFlight: ['t1'] }, {}, { cadence: [LATER] })
    expect(b.note).toContain('OVERRIDDEN by an explicit beat')
    expect(b.note).toContain('in flight')
  })

  test('starts the wall clock, because the run really is dispatching now', () => {
    const b = beat({ forced: true }, { dispatch: [card('t1')] }, { cadence: [LATER] })
    expect(b.patch?.startedAt).toBe('2026-08-21T00:00:00.000Z')
  })

  test('does NOT override a closed window', () => {
    const b = beat({ forced: true, windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['window'] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('window is closed')
  })

  test('does NOT override the queue -- that gate is a promise to other epics', () => {
    const b = beat({ forced: true, queue: BLOCKED }, { dispatch: [card('t1')] }, { cadence: ['queue'] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('position 2 of 3')
  })

  test('an appointment it overrode does not un-hold the OTHER gates', () => {
    const b = beat({ forced: true, windowOpen: false }, { dispatch: [card('t1')] }, { cadence: ['window', LATER] })
    expect(kinds(b)).toEqual([])
    expect(b.note).toContain('window is closed')
    expect(b.note).not.toContain('waiting until')
  })

  test('the SWEEP never overrides -- `forced` absent is the caller that must not', () => {
    expect(kinds(beat({}, { dispatch: [card('t1')] }, { cadence: [LATER] }))).toEqual([])
  })
})
