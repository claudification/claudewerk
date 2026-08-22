/**
 * THE CAPS SENTENCE -- the one line of this prompt the werk-master is told the
 * ENGINE enforces, and therefore the one line it plans against.
 *
 * `epic-run-caps.test.ts` pins the arithmetic. These pin the two things the
 * PROMPT is responsible for: that the sentence quotes the run object it was
 * handed and nothing else, and that its clock is the one the engine injected.
 *
 * The clock is not a detail. It was `Date.now()`, read inside a pure builder, so
 * the elapsed figure in the sentence came from a different instant than every
 * other number in it -- and no test could state what the line should say.
 */

import { describe, expect, test } from 'bun:test'
import { buildWerkMasterPrompt, type WerkMasterPromptCtx } from './epic-prompt-werk-master'
import type { EpicPlan } from './epic-ready'
import type { EpicRunReading } from './epic-run-types'

const T0 = Date.parse('2026-08-21T15:12:38.257Z')
const at = (minutes: number) => T0 + minutes * 60_000

const RUN: EpicRunReading = {
  epicId: 'e1',
  project: 'claude://s/p',
  cadence: ['now'],
  status: 'running',
  gen: 3,
  target: 'merged',
  dryGens: 0,
  unlandedWoken: '',
  maxGens: 40,
  maxUsd: 500,
  maxWallClockMinutes: 960,
  spentUsd: 0,
  concurrency: 3,
  plan: false,
  planned: true,
  created: '',
  updated: '',
  digest: '',
}

const PLAN: EpicPlan = {
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

const prompt = (run: Partial<EpicRunReading>, nowMs = T0): string =>
  buildWerkMasterPrompt({
    projectUri: 'claude://s/p',
    projectRoot: '/p',
    run: { ...RUN, ...run },
    plan: PLAN,
    batonTail: '_(empty)_',
    wake: 'card-settled',
    settled: [],
    nowMs,
  } satisfies WerkMasterPromptCtx)

describe('the budget sentence', () => {
  test('quotes the spend on the run it was handed, ceiling and remainder together', () => {
    expect(prompt({ spentUsd: 110.954458 })).toContain('spend $110.95/$500.00 ($389.05 left)')
  })

  /**
   * THE GEN-3 OBSERVATION, at the unit. The sentence read `256 min/480 min`
   * while the run said `960` and had been going 14 minutes -- every number in it
   * belonged to a copy of the run that predated the beat rendering it. Nothing in
   * this builder may reach past its argument for any of them.
   */
  test('quotes the ceiling and the elapsed minutes from that same object', () => {
    const line = prompt({ startedAt: new Date(at(-14)).toISOString() })
    expect(line).toContain('wall clock 14 min/960 min (946 min left)')
    expect(line).not.toContain('480 min')
  })

  /** The clock is INJECTED, so the elapsed figure is a fact about the beat rather
   *  than about the moment the string happened to be built. */
  test('measures elapsed against the injected clock, never the process clock', () => {
    expect(prompt({ startedAt: new Date(at(-90)).toISOString() }, at(30))).toContain('wall clock 120 min/960 min')
  })

  test('a run whose clock has not started says so rather than inventing a number', () => {
    expect(prompt({})).toContain('wall clock not started/960 min')
  })

  test('and the sentence still tells the werk-master the engine enforces it without asking', () => {
    expect(prompt({})).toContain("THE RUN'S BUDGET, which the ENGINE enforces without consulting you:")
  })
})

/**
 * THE CHEAPEST OF THE THREE FIXES, and the only one that stops the deadlock
 * happening at all rather than recovering from it ten minutes later.
 *
 * A blocking Bash call keeps the agent-host socket AND emits no events, so it is
 * invisible to both halves of the engine's liveness machinery: `werkMasterAlive`
 * stays true and `seatAbandoned` (which requires NO socket) can never reap it.
 * Gen 14 of `epic-the-wall-ii` stopped a run dead this way on 2026-08-20.
 *
 * Pinned as a test rather than trusted to the prose, because a prompt is a string
 * nothing else reads: an edit that drops this paragraph breaks no build, fails no
 * type check, and is discovered by the next deadlock.
 */
describe('the werk-master is told, in the prompt, never to block', () => {
  const NEVER_BLOCK_RUN: EpicRunReading = {
    ...RUN,
    epicId: 'werk-epic',
    project: 'claude://sentinel/Users/jonas/projects/remote-claude',
    gen: 4,
    maxUsd: 100,
    maxWallClockMinutes: 480,
  }

  const ctx: WerkMasterPromptCtx = {
    projectUri: NEVER_BLOCK_RUN.project,
    projectRoot: '/Users/jonas/projects/remote-claude',
    run: NEVER_BLOCK_RUN,
    plan: PLAN,
    batonTail: '_(empty)_',
    wake: 'card-settled',
    settled: [],
    nowMs: T0,
  }

  const built = buildWerkMasterPrompt(ctx)

  test('the rule is stated as a rule, not implied', () => {
    expect(built).toContain('NEVER BLOCK IN BASH')
  })

  test.each(['until', 'sleep', 'polling loop'])('and names the shape it means: %s', shape => {
    expect(built).toContain(shape)
  })

  test('it says WHY -- a live werk-master holds the whole run', () => {
    expect(built).toContain('HOLDS THE ENTIRE')
  })

  /** "Do not block" alone leaves a werk-master that genuinely needs a long job with
   *  nothing to do instead, which is how the rule gets rationalised away. */
  test('and what to do instead: background it, write the baton, end the turn', () => {
    expect(built).toContain('BACKGROUND')
    expect(built).toContain('END YOUR TURN')
  })
})
