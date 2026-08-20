import { describe, expect, test } from 'bun:test'
import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRunSnapshot } from '../shared/protocol'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
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

  test('every seat runs bypassPermissions and headless, ad-hoc', () => {
    for (const plan of [overseer(), planImplementerSpawn(CTX, 't1'), planVerifierSpawn(CTX, 't1')]) {
      expect(plan.permissionMode).toBe('bypassPermissions')
      expect(plan.headless).toBe(true)
      expect(plan.adHoc).toBe(true)
    }
  })

  /**
   * REGRESSION: this file used to declare `dontAsk` and a test used to assert it,
   * while `resolveSpawnConfig` rewrote every ad-hoc spawn to `bypassPermissions`
   * downstream. Both statements passed; neither described the running system.
   *
   * Asserting the DECLARED value alone cannot catch that, so this asserts the
   * value that actually reaches the sentinel -- the two must agree.
   */
  test('the declared mode survives resolution -- no downstream rewrite', () => {
    for (const plan of [overseer(), planImplementerSpawn(CTX, 't1'), planVerifierSpawn(CTX, 't1')]) {
      const resolved = resolveSpawnConfig(plan as never)
      expect(resolved.permissionMode).toBe(plan.permissionMode)
    }
  })

  /**
   * The mode is only safe because the guards are mode-INDEPENDENT. If the deny
   * floor ever became allowlist-shaped, bypassPermissions would be a blank cheque.
   */
  test('bypass does not disarm the deny-floor', () => {
    const settings = planImplementerSpawn(CTX, 't1').settingsInline as {
      permissions: { deny: string[] }
      hooks: { PreToolUse: unknown[] }
    }
    expect(settings.permissions.deny).toContain('Bash(sudo:*)')
    expect(settings.permissions.deny.some(r => r.includes('force'))).toBe(true)
    expect(settings.hooks.PreToolUse.length).toBeGreaterThan(0)
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

/**
 * THE 2026-08-20 INCIDENT, pinned.
 *
 * `epic/epic-the-wall-ii/verify-epic-engine-baton-window-relitigates-settles` is
 * 73 characters. Claude Code refuses a worktree name over 64 and exits 1 in
 * ~1.2s, so the verifier never booted, produced zero output, and the sweep read
 * its death as a completed leg. The conversation NAME had a budget; the worktree
 * name did not, and it is the longer of the two by construction (`verify-` on
 * top of the full card id, no truncation anywhere).
 *
 * The real line, off the sentinel's headless log for conv 90dd07af:
 *   `ERR Error creating worktree: Invalid worktree name: must be 64 characters
 *    or fewer (got 73)`
 */
describe('worktree names fit inside CC’s 64-character limit', () => {
  const LONG = 'epic-engine-baton-window-relitigates-settles'
  const ctx: EpicSpawnCtx = { ...CTX, epicId: 'epic-the-wall-ii' }

  test('the incident case: a verifier for a 43-char card id', () => {
    const plan = planVerifierSpawn(ctx, LONG)
    expect(plan.worktree).toBeDefined()
    expect((plan.worktree as string).length).toBeLessThanOrEqual(64)
  })

  test('an implementer branch is capped too -- and the PROMPT names the same branch', () => {
    const plan = planImplementerSpawn({ ...ctx, epicId: 'a-fairly-long-epic-identifier-here' }, `${LONG}-and-more`)
    const branch = plan.worktree as string
    expect(branch.length).toBeLessThanOrEqual(64)
    expect(plan.prompt).toContain(branch)
  })

  test('two long siblings that share a prefix do NOT truncate onto the same branch', () => {
    const a = planVerifierSpawn(ctx, `${LONG}-alpha`).worktree
    const b = planVerifierSpawn(ctx, `${LONG}-bravo`).worktree
    expect(a).not.toBe(b)
  })

  test('the branch is deterministic -- a retry lands on the same worktree', () => {
    expect(planVerifierSpawn(ctx, LONG).worktree).toBe(planVerifierSpawn({ ...ctx, gen: 99 }, LONG).worktree)
  })

  test('a short card id is left exactly as it was -- no gratuitous hashing', () => {
    expect(planImplementerSpawn(CTX, 't1').worktree).toBe('epic/werk-epic/t1')
    expect(planVerifierSpawn(CTX, 't1').worktree).toBe('epic/werk-epic/verify-t1')
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

/**
 * THE NAMES USED TO BE PURELY DETERMINISTIC, and the spawn gate refuses any name
 * that ANY conversation has ever held -- ended ones included (spawn-naming.ts:82,
 * over the whole conversation store). So the first dispatch of a card claimed its
 * name forever and every retry after a bounce died on
 * `Session name "..." is already in use`. Live on 2026-08-19 that refusal filled
 * the broker log every 45 seconds while the run made no progress at all.
 */
describe('seat names are unique per ATTEMPT, not just per card', () => {
  const ctx = (gen: number): EpicSpawnCtx => ({ ...CTX, gen })
  const seat = (gen: number) =>
    planOverseerSpawn(ctx(gen), {
      projectUri: CTX.project,
      projectRoot: CTX.projectRoot,
      run: { ...RUN, digest: 'x' },
      plan: PLAN,
      batonTail: '_(empty)_',
      wake: 'card-settled',
      settled: [],
    }).name

  test('two generations of the same card get different names', () => {
    expect(planImplementerSpawn(ctx(1), 'wall-filter-store').name).not.toBe(
      planImplementerSpawn(ctx(5), 'wall-filter-store').name,
    )
  })

  test('a verifier never collides with the implementer of the same card and generation', () => {
    expect(planVerifierSpawn(ctx(6), 'card-a').name).not.toBe(planImplementerSpawn(ctx(6), 'card-a').name)
  })

  test('two overseer generations get different names', () => {
    expect(seat(6)).not.toBe(seat(7))
  })

  /**
   * The name is truncated to 60 from the RIGHT, so a discriminator in the tail is
   * the first thing destroyed. These pin that the generation survives a card id
   * long enough to overflow the budget.
   */
  test('a very long card id is shortened, and the generation SURVIVES', () => {
    const name = planVerifierSpawn(ctx(6), 'main-biome-residue-conversation-item-helpers-and-then-some').name
    expect(name.length).toBeLessThanOrEqual(60)
    expect(name.endsWith(' g6')).toBe(true)
  })

  test('the name still says which epic and which card, for a human reading the list', () => {
    const name = planImplementerSpawn(ctx(6), 'wall-filter-store').name
    expect(name).toContain(CTX.epicId)
    expect(name).toContain('wall-filter-store')
  })
})
