import { describe, expect, test } from 'bun:test'
import { buildOverseerPrompt, type OverseerPromptCtx } from './epic-prompt-overseer'
import type { EpicPlan } from './epic-ready'
import type { EpicRunReading } from './epic-run-types'

const RUN: EpicRunReading = {
  epicId: 'werk-epic',
  project: 'claude://sentinel/Users/jonas/projects/remote-claude',
  cadence: ['now'],
  status: 'running',
  gen: 4,
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
  digest: 'x',
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
  complete: false,
}

const CTX: OverseerPromptCtx = {
  projectUri: RUN.project,
  projectRoot: '/Users/jonas/projects/remote-claude',
  run: RUN,
  plan: PLAN,
  batonTail: '_(empty)_',
  wake: 'card-settled',
  settled: [],
}

/**
 * THE CHEAPEST OF THE THREE FIXES, and the only one that stops the deadlock
 * happening at all rather than recovering from it ten minutes later.
 *
 * A blocking Bash call keeps the agent-host socket AND emits no events, so it is
 * invisible to both halves of the engine's liveness machinery: `overseerAlive`
 * stays true and `seatAbandoned` (which requires NO socket) can never reap it.
 * Gen 14 of `epic-the-wall-ii` stopped a run dead this way on 2026-08-20.
 *
 * Pinned as a test rather than trusted to the prose, because a prompt is a string
 * nothing else reads: an edit that drops this paragraph breaks no build, fails no
 * type check, and is discovered by the next deadlock.
 */
describe('the overseer is told, in the prompt, never to block', () => {
  const prompt = buildOverseerPrompt(CTX)

  test('the rule is stated as a rule, not implied', () => {
    expect(prompt).toContain('NEVER BLOCK IN BASH')
  })

  test.each(['until', 'sleep', 'polling loop'])('and names the shape it means: %s', shape => {
    expect(prompt).toContain(shape)
  })

  test('it says WHY -- a live overseer holds the whole run', () => {
    expect(prompt).toContain('HOLDS THE ENTIRE')
  })

  /** "Do not block" alone leaves an overseer that genuinely needs a long job with
   *  nothing to do instead, which is how the rule gets rationalised away. */
  test('and what to do instead: background it, write the baton, end the turn', () => {
    expect(prompt).toContain('BACKGROUND')
    expect(prompt).toContain('END YOUR TURN')
  })
})
