/**
 * THE WERK-PLANNER PROMPT, in its two framings.
 *
 * ONE SEAT, ONE PROMPT BUILDER, TWO JOBS. Generation 0 completes a graph nobody
 * wrote; a leg's re-plan REPAIRS a graph that was true and stopped being true.
 * They are the same six steps against a tree that has moved, so the reuse is the
 * design -- and this file is what stops the reuse from quietly meaning the
 * re-plan gets handed generation 0's wording.
 *
 * WHY IT MATTERS THAT THE WORDING DIFFERS. A model told "this is generation 0,
 * before anything is dispatched" reads the existing `depends_on` edges as
 * somebody's decision and leaves them alone -- which is the one thing a re-plan
 * exists to do. And a model told "the run CHECKPOINTS and Jonas reviews your
 * plan" writes for a gate that will not fire, when what it is actually writing is
 * the only account anybody gets.
 */

import { describe, expect, test } from 'bun:test'
import { buildWerkPlannerPrompt } from './epic-prompt-werk-planner'
import type { EpicPlan } from './epic-ready'
import type { EpicRunReading } from './epic-run-types'

const RUN: EpicRunReading = {
  epicId: 'epic-agile',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 0,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 500,
  maxWallClockMinutes: 480,
  spentUsd: 0,
  legBudgetUsd: 200,
  legStartUsd: 0,
  leg: 1,
  concurrency: 3,
  plan: true,
  planned: false,
  created: '',
  updated: '',
  digest: '',
}

const PLAN = {
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
  awaitingDeploy: [],
  unlanded: [],
  complete: false,
} as EpicPlan

const prompt = (over: Partial<EpicRunReading> = {}) =>
  buildWerkPlannerPrompt({
    projectUri: 'claude://s/p',
    projectRoot: '/p',
    run: { ...RUN, ...over },
    plan: PLAN,
    cardLines: ['t1 -- do the thing (open)'],
    epicBody: 'Make the loop agile.',
  })

/** The six steps the card names, present in BOTH framings -- a re-plan that
 *  skipped one would not be "the gen-0 pass re-run against the remainder". */
const SIX_STEPS = [
  'CLOSE WHAT IS ALREADY DONE',
  'FILE WHAT IS MISSING',
  'DROP WHAT STOPPED MAKING SENSE',
  'WRITE THE EDGES',
  'WRITE THE BATON',
]

describe('generation 0', () => {
  test('says it is generation 0 and that the checkpoint is a GATE', () => {
    const p = prompt()
    expect(p).toContain('This is generation 0')
    expect(p).toContain('the run CHECKPOINTS and Jonas reviews your plan')
  })

  test('does not talk about drift -- there is no previous plan to have decayed', () => {
    expect(prompt()).not.toContain('THIS IS A RE-PLAN')
  })

  test.each(SIX_STEPS)('carries the pass: %s', step => {
    expect(prompt()).toContain(step)
  })
})

describe('a leg re-plan', () => {
  const REPLAN = { leg: 3 } as Partial<EpicRunReading>

  test('names the leg it opens rather than calling itself generation 0', () => {
    const p = prompt(REPLAN)
    expect(p).toContain('the RE-PLAN that opens leg 3')
    expect(p).not.toContain('This is generation 0')
  })

  /**
   * THE INSTRUCTION THE WHOLE CARD TURNS ON. "Rewrite the `depends_on` edges
   * against the code as it NOW exists" is step 5 of the remainder pass, and a
   * model that treats the existing edges as settled decisions performs the other
   * five steps and silently skips the one that matters.
   */
  test('orders the edges RE-DERIVED against the tree, not merely reviewed', () => {
    const p = prompt(REPLAN)
    expect(p).toContain('ORDERING EDGES GO STALE')
    expect(p).toContain('EVIDENCE RATHER THAN')
    expect(p).toContain('as it NOW exists')
    expect(p).toContain('An edge you keep because it was already there is an edge you have not checked')
  })

  test('says deleting a stale edge is as valuable as adding a missing one', () => {
    expect(prompt(REPLAN)).toContain('Deleting a stale edge is')
  })

  test('scopes the pass to the REMAINDER', () => {
    expect(prompt(REPLAN)).toContain('SCOPE YOURSELF TO THE REMAINDER')
  })

  /** AUTO, not a gate -- and the prompt must not promise a review that will not
   *  happen, or the baton entry gets written as an argument for a gate. */
  test('tells the seat the run does NOT wait for a human afterwards', () => {
    const p = prompt(REPLAN)
    expect(p).toContain('The run does NOT wait for a human after you')
    expect(p).toContain('there is no gate at a leg')
    expect(p).not.toContain('the run CHECKPOINTS and Jonas reviews your plan')
  })

  test('the digest it writes is the NEXT leg plan of record', () => {
    expect(prompt(REPLAN)).toContain("leg 3's plan of record")
  })

  test.each(SIX_STEPS)('still carries the whole pass: %s', step => {
    expect(prompt(REPLAN)).toContain(step)
  })
})
