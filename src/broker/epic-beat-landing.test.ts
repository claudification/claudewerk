/**
 * HOLD, ESCALATE, THEN PARK -- the beat's half of the landing gate.
 *
 * The HOLD is arithmetic and lives in `epic-ready-landing.test.ts`. This file is
 * the other two steps and the escalation ledger that decides between them.
 *
 * Its own file rather than more of `epic-beat.test.ts` (already 874 lines), and
 * it takes that file's fixtures by re-declaring the two it needs -- the beat is a
 * pure function, so a fixture is four lines and sharing one across files would
 * make either file's failures reference the other's setup.
 */

import { describe, expect, test } from 'bun:test'
import type { CardLanding } from '../shared/epic-landing'
import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicAction, type EpicBeatInput, planBeat } from './epic-beat'

const RUN: EpicRunSnapshot = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
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
  unlanded: [],
  complete: false,
}

const unlanded = (cardId: string, verdict: CardLanding['verdict'] = 'unmerged'): CardLanding => ({
  cardId,
  branch: `worktree-epic/e1/${cardId}`,
  verdict,
  evidence: verdict === 'unmerged' ? 'committed' : 'merged',
})

function beat(plan: Partial<EpicPlan> = {}, run: Partial<EpicRunSnapshot> = {}, over: Partial<EpicBeatInput> = {}) {
  return planBeat({
    run: { ...RUN, ...run },
    gen: run.gen ?? RUN.gen,
    plan: { ...EMPTY_PLAN, ...plan },
    inFlight: [],
    werkMasterAlive: false,
    unacknowledged: [],
    windowOpen: true,
    boardFingerprint: '',
    spentUsd: 0,
    nowMs: Date.parse('2026-08-22T00:00:00.000Z'),
    ...over,
  })
}

const kinds = (b: ReturnType<typeof planBeat>) => b.actions.map(a => a.kind)
const wake = (b: ReturnType<typeof planBeat>) =>
  b.actions.find((a): a is Extract<EpicAction, { kind: 'wake-werk-master' }> => a.kind === 'wake-werk-master')

describe('step 2 -- WAKE THE WERK-MASTER, once', () => {
  test('unlanded work wakes it under a reason of its own', () => {
    const b = beat({ unlanded: [unlanded('t1')] })
    expect(kinds(b)).toEqual(['wake-werk-master'])
    expect(wake(b)?.reason).toBe('unmerged-work')
  })

  test('the note carries the BRANCH -- a reason without one is a reason nobody can act on', () => {
    expect(beat({ unlanded: [unlanded('t1')] }).note).toContain('worktree-epic/e1/t1')
  })

  test('the wake is recorded against the generation, in the one thing this feature persists', () => {
    expect(beat({ unlanded: [unlanded('t1')] }, { gen: 3 }).patch).toMatchObject({ unlandedWoken: 't1@3' })
  })

  test('a card already escalated at THIS generation escalates nothing -- not again, not a park', () => {
    // What stops the standing question becoming a 45-second loop when a CAS
    // refuses the wake and the generation therefore does not move. The beat falls
    // through to the ordinary engine below it, which on an empty board is a dry
    // generation -- so what is asserted is that the LANDING gate did nothing, not
    // that the beat did.
    const b = beat({ unlanded: [unlanded('t1')] }, { gen: 3, unlandedWoken: 't1@3' })
    expect(kinds(b)).not.toContain('park')
    expect(wake(b)?.reason).not.toBe('unmerged-work')
    expect(b.patch?.unlandedWoken).toBeUndefined()
  })

  test('a second card unlanded later is added to the ledger rather than replacing it', () => {
    const b = beat({ unlanded: [unlanded('t1'), unlanded('t2')] }, { gen: 5, unlandedWoken: 't1@5' })
    expect(kinds(b)).toEqual(['wake-werk-master'])
    expect(b.patch?.unlandedWoken).toBe('t1@5,t2@5')
  })

  test('a BELOW the settle branch: a card that just settled is not escalated on the same beat', () => {
    // A card is unmerged the instant its werk-worker commits. Escalating there
    // would fire on every healthy card in every run, before the werk-master had a
    // single generation to merge it -- the settle wake IS that generation.
    const b = beat({ unlanded: [unlanded('t1')] }, {}, { unacknowledged: ['t1'] })
    expect(wake(b)?.reason).toBe('card-settled')
    expect(b.patch?.unlandedWoken).toBeUndefined()
  })

  test('it outranks open questions and all dispatch', () => {
    const b = beat({ unlanded: [unlanded('t1')], questions: [], dispatch: [] })
    expect(kinds(b)).toEqual(['wake-werk-master'])
  })
})

describe('step 3 -- PARK, once the seat whose job it is has had its generation', () => {
  test('still unlanded at a LATER generation parks the run', () => {
    const b = beat({ unlanded: [unlanded('t1')] }, { gen: 4, unlandedWoken: 't1@3' })
    expect(kinds(b)).toEqual(['park'])
  })

  test('the park reason names the branch and what to do about it', () => {
    const b = beat({ unlanded: [unlanded('t1')] }, { gen: 4, unlandedWoken: 't1@3' })
    const park = b.actions.find(a => a.kind === 'park')
    expect(park && 'reason' in park ? park.reason : '').toContain('worktree-epic/e1/t1')
    expect(park && 'reason' in park ? park.reason : '').toContain('re-arm')
  })

  test('a card that LANDED between the two beats parks nothing -- the fact is derived', () => {
    // The ledger entry is still there and is inert, which is the whole reason a
    // stale escalation cannot freeze a run the way a stored `unmerged:` mark
    // would: the gate fires off git, not off the record of having asked.
    expect(kinds(beat({ unlanded: [] }, { gen: 9, unlandedWoken: 't1@3' }))).not.toContain('park')
  })

  test('a stale card parks even while a fresh one would have woken', () => {
    // Park wins: the run is already broken, and a wake would buy one more
    // generation for a seat that has already had one.
    expect(kinds(beat({ unlanded: [unlanded('t1'), unlanded('t2')] }, { gen: 4, unlandedWoken: 't1@3' }))).toEqual([
      'park',
    ])
  })

  test('a merged branch with its worktree still standing escalates and parks on the same path', () => {
    expect(wake(beat({ unlanded: [unlanded('t1', 'standing')] }))?.reason).toBe('unmerged-work')
    expect(kinds(beat({ unlanded: [unlanded('t1', 'standing')] }, { gen: 4, unlandedWoken: 't1@3' }))).toEqual(['park'])
  })
})

describe('the FRICTION entry', () => {
  const three = [unlanded('a'), unlanded('b'), unlanded('c')]

  test('two hand-merges is bad luck; nothing is filed', () => {
    expect(kinds(beat({ unlanded: [unlanded('a'), unlanded('b')] }))).toEqual(['wake-werk-master'])
  })

  test('the third one in a run files a friction entry naming the operation', () => {
    const b = beat({ unlanded: three })
    expect(kinds(b)).toEqual(['wake-werk-master', 'friction'])
    const f = b.actions.find(a => a.kind === 'friction')
    expect(f && 'operation' in f ? f.operation : '').toContain('merge')
    expect(f && 'count' in f ? f.count : 0).toBe(3)
  })

  test('it names what should have been automated instead', () => {
    const f = beat({ unlanded: three }).actions.find(a => a.kind === 'friction')
    expect(f && 'detail' in f ? f.detail : '').toContain('Automate the merge')
  })

  test('it fires on the CROSSING and never again -- no second counter to persist', () => {
    const after = beat({ unlanded: [...three, unlanded('d')] }, { gen: 3, unlandedWoken: 'a@3,b@3,c@3' })
    expect(kinds(after)).toEqual(['wake-werk-master'])
  })
})

describe('the gate is DERIVED, so a run.md that cannot be read changes nothing', () => {
  test('an empty unlanded list from a beat that could not resolve one blocks nothing', () => {
    // A failed read reaches the beat as "no landings", not as "everything is
    // unmerged" -- so the run neither freezes on a timeout nor loses the gate.
    // `epic-executor-landing.test.ts` proves the same thing end to end.
    const b = beat({ unlanded: [], dispatch: [] }, { unlandedWoken: 'a@1,b@1' })
    expect(kinds(b)).not.toContain('park')
    expect(wake(b)?.reason).not.toBe('unmerged-work')
    expect(b.patch?.unlandedWoken).toBeUndefined()
  })
})
