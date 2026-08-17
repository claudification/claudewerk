import { describe, expect, test } from 'bun:test'
import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'
import { type EpicSpawnCtx, planImplementerSpawn, planOverseerSpawn, planVerifierSpawn } from './epic-spawn-plan'

const CTX: EpicSpawnCtx = {
  project: 'claude://sentinel/Users/jonas/projects/remote-claude',
  projectRoot: '/Users/jonas/projects/remote-claude',
  epicId: 'werk-epic',
  gen: 4,
}

const RUN: EpicRunSnapshot = {
  epicId: 'werk-epic',
  project: CTX.project,
  cadence: 'now',
  status: 'running',
  gen: 4,
  target: 'merged',
  dryGens: 0,
  maxGens: 40,
  concurrency: 3,
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
  complete: false,
}

const overseer = () =>
  planOverseerSpawn(CTX, {
    projectUri: CTX.project,
    projectRoot: CTX.projectRoot,
    run: { ...RUN, digest: 'x' },
    plan: PLAN,
    batonTail: '_(empty)_',
    wake: 'card-settled',
    settled: ['t1 landed'],
  })

/** The mute is a second PreToolUse hook keyed on tool name. */
const hookCount = (s: Record<string, unknown>) => (s.hooks as { PreToolUse: unknown[] }).PreToolUse.length

describe('the three seats differ in what they CAN do, not just what they are told', () => {
  test('an implementer is muted', () => {
    expect(hookCount(planImplementerSpawn(CTX, 't1').settingsInline)).toBe(2)
  })

  test('a verifier is muted -- it judges, it does not escalate', () => {
    expect(hookCount(planVerifierSpawn(CTX, 't1').settingsInline)).toBe(2)
  })

  test('the overseer keeps its voice', () => {
    expect(hookCount(overseer().settingsInline)).toBe(1)
  })

  test('every seat runs dontAsk and headless, ad-hoc', () => {
    for (const plan of [overseer(), planImplementerSpawn(CTX, 't1'), planVerifierSpawn(CTX, 't1')]) {
      expect(plan.permissionMode).toBe('dontAsk')
      expect(plan.headless).toBe(true)
      expect(plan.adHoc).toBe(true)
    }
  })
})

describe('worktrees', () => {
  test('an implementer gets its own branch, named for the card', () => {
    const plan = planImplementerSpawn(CTX, 't1')
    expect(plan.worktree).toBe('epic/werk-epic/t1')
    expect(plan.prompt).toContain('epic/werk-epic/t1')
  })

  test('a verifier gets a SEPARATE scratch worktree from the implementer', () => {
    expect(planVerifierSpawn(CTX, 't1').worktree).not.toBe(planImplementerSpawn(CTX, 't1').worktree)
  })

  test('the overseer has NO worktree -- it judges main, it cannot hide from it', () => {
    expect(overseer().worktree).toBeUndefined()
  })
})

describe('the launch tag', () => {
  test('carries the seat, the card and the dispatching generation', () => {
    expect(planImplementerSpawn(CTX, 't1').epic).toEqual({
      epicId: 'werk-epic',
      role: 'implementer',
      gen: 4,
      cardId: 't1',
    })
  })

  test('the overseer serves the epic, not a card', () => {
    expect(overseer().epic.cardId).toBeUndefined()
    expect(overseer().epic.role).toBe('overseer')
  })
})

describe('the prompts say the load-bearing things', () => {
  test('an implementer is told there is no human AND what to do instead', () => {
    const prompt = planImplementerSpawn(CTX, 't1').prompt
    expect(prompt).toContain('THERE IS NO HUMAN')
    expect(prompt).toContain('needs-overseer')
    expect(prompt).toContain('depends_on')
  })

  test('an implementer is told it may not approve its own work', () => {
    const prompt = planImplementerSpawn(CTX, 't1').prompt
    expect(prompt).toContain('in-review')
    expect(prompt).toContain('may not approve your own work')
  })

  test('the verifier is told to distrust the worker', () => {
    expect(planVerifierSpawn(CTX, 't1').prompt).toContain('do NOT trust')
  })

  test('the overseer is told it is the only route to a human', () => {
    expect(overseer().prompt).toContain('ONLY CONVERSATION IN THIS RUN THAT MAY TALK TO A HUMAN')
  })

  test('the overseer prompt carries the wake reason and what settled', () => {
    const prompt = overseer().prompt
    expect(prompt).toContain('card-settled')
    expect(prompt).toContain('t1 landed')
  })

  test('names stay inside the 80-char field', () => {
    const long = { ...CTX, epicId: 'a-very-long-epic-identifier-that-goes-on-and-on-forever-and-ever' }
    expect(planImplementerSpawn(long, 'another-really-long-card-id-here').name.length).toBeLessThanOrEqual(80)
  })
})
