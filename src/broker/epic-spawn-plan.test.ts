import { describe, expect, test } from 'bun:test'
import { EPIC_ORDERS } from '../shared/epic-orders'
import { buildImplementerPrompt } from '../shared/epic-prompt-implementer'
import type { OverseerPromptCtx } from '../shared/epic-prompt-overseer'
import type { EpicPlan } from '../shared/epic-ready'
import type { EpicRole } from '../shared/epic-run-types'
import { buildEpicWorkerSettings } from '../shared/epic-worker-permissions'
import { buildGuardPrompt } from '../shared/guard-prompt'
import { OrderCapsError } from '../shared/order-caps'
import type { EpicRunSnapshot } from '../shared/protocol'
import { resolveSpawnConfig } from '../shared/spawn-defaults'
import { worktreeBranch } from '../shared/worktree-path'
import {
  type EpicSpawnCtx,
  type EpicSpawnPlan,
  planImplementerSpawn,
  planOverseerSpawn,
  planPlannerSpawn,
  planVerifierSpawn,
} from './epic-spawn-plan'

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
  complete: false,
}

const PROMPT_CTX: OverseerPromptCtx = {
  projectUri: CTX.project,
  projectRoot: CTX.projectRoot,
  run: { ...RUN, digest: 'x' },
  plan: PLAN,
  batonTail: '_(empty)_',
  wake: 'card-settled',
  settled: ['t1 landed'],
}

const overseer = () => planOverseerSpawn(CTX, PROMPT_CTX)

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
  test('an implementer gets its own worktree, named for the card', () => {
    expect(planImplementerSpawn(CTX, 't1').worktree).toBe('epic/werk-epic/t1')
  })

  /**
   * The WORK RULES line used to quote the WORKTREE NAME as if it were the branch,
   * so an implementer was told `epic/<epic>/<card>` while `git branch
   * --show-current` in its own tree said `worktree-epic/<epic>/<card>`. Measured
   * on the worktree that fixed this, not inferred.
   *
   * `toContain` is not enough on its own here -- the un-prefixed name is a
   * SUBSTRING of the prefixed one, so the wrong string passes a containment
   * assertion. The negative half is what actually pins the bug: rule 1 must not
   * quote the bare name.
   */
  test('the prompt names the REAL branch, `worktree-` prefixed -- not the worktree name', () => {
    const plan = planImplementerSpawn(CTX, 't1')
    expect(plan.prompt).toContain(`Work on branch \`${worktreeBranch('epic/werk-epic/t1')}\``)
    expect(plan.prompt).not.toContain('Work on branch `epic/werk-epic/t1`')
    expect(plan.worktree).toBe('epic/werk-epic/t1')
  })

  /**
   * The hazard the card was raised for: from `epic-implementer-base-lacks-deps`
   * onwards one prompt quotes TWO branch refs. If they disagree on the prefix, an
   * implementer that reasons "rule 1 drops it, so the merge ref probably does
   * too" runs `git merge` against a ref that does not resolve.
   */
  test('both branch refs in one prompt use the same spelling', () => {
    const prompt = planImplementerSpawn(CTX, 't1', 'main', ['t0']).prompt
    expect(prompt).toContain(`\`${worktreeBranch('epic/werk-epic/t1')}\``)
    expect(prompt).toContain(`\`${worktreeBranch('epic/werk-epic/t0')}\``)
    for (const line of prompt.split('\n')) {
      const bare = line.match(/`epic\/werk-epic\/[^`]+`/)
      expect(bare, `un-prefixed branch ref leaked into: ${line}`).toBeNull()
    }
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

  test('an implementer worktree is capped too -- and the PROMPT names the branch cut from it', () => {
    const plan = planImplementerSpawn({ ...ctx, epicId: 'a-fairly-long-epic-identifier-here' }, `${LONG}-and-more`)
    const worktree = plan.worktree as string
    expect(worktree.length).toBeLessThanOrEqual(64)
    // The SHORTENING must survive the prefixing: the prompt names the shortened
    // worktree's branch, so a hash the cap introduced appears in the merge ref
    // too. The cap itself is on the worktree name -- CC's limit, not git's.
    expect(plan.prompt).toContain(`Work on branch \`${worktreeBranch(worktree)}\``)
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

describe("a dependency's branch, as the implementer is told to merge it", () => {
  const LONG_DEP = 'epic-engine-baton-window-relitigates-settles-dependency'

  test('it is the `worktree-` prefixed branch, not the worktree name', () => {
    const prompt = planImplementerSpawn(CTX, 't1', 'main', ['t0']).prompt
    // `worktreeBranch(seatBranch(...))` -- the prefix scripts/worktree-create.sh
    // adds. Quoting the plan's own `worktree` field here would be a ref that
    // `git merge` cannot resolve.
    expect(prompt).toContain(`\`${worktreeBranch('epic/werk-epic/t0')}\``)
  })

  test('a dependency branch that had to be SHORTENED is named as shortened', () => {
    const dep = LONG_DEP
    const ctx = { ...CTX, epicId: 'a-fairly-long-epic-identifier-here' }
    // The dependency's own seat would get this worktree; the merge ref is that,
    // prefixed. Derived from the same function rather than hand-typed, so a
    // change to the shortening cannot silently desync the two.
    const depWorktree = planImplementerSpawn(ctx, dep).worktree as string
    expect(depWorktree.length).toBeLessThanOrEqual(64)
    expect(planImplementerSpawn(ctx, 't1', 'main', [dep]).prompt).toContain(worktreeBranch(depWorktree))
  })

  test('no dependency, no section -- a leaf card is dispatched with the prompt it always had', () => {
    expect(planImplementerSpawn(CTX, 't1').prompt).toBe(planImplementerSpawn(CTX, 't1', 'main', []).prompt)
    expect(planImplementerSpawn(CTX, 't1').prompt).not.toContain('DEPENDS ON WORK')
  })

  test('every dependency of a card reaches the prompt', () => {
    const prompt = planImplementerSpawn(CTX, 't3', 'main', ['t1', 't2']).prompt
    expect(prompt).toContain(worktreeBranch('epic/werk-epic/t1'))
    expect(prompt).toContain(worktreeBranch('epic/werk-epic/t2'))
  })

  test('passing dependencies changes NOTHING about readiness or the base ref', () => {
    const plain = planImplementerSpawn(CTX, 't1')
    const withDeps = planImplementerSpawn(CTX, 't1', 'main', ['t0'])
    expect(withDeps.worktree).toBe(plain.worktree as string)
    expect(withDeps.name).toBe(plain.name)
    expect(withDeps.prompt).toContain('cut from `main`')
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

/**
 * STEP 2's ACCEPTANCE TEST, and the only one that can fail it.
 *
 * The seats moved out of this file into `order@1` artifacts (`epic-orders.ts`)
 * and the planners now COMPILE card + order. That is a refactor, so the bar is
 * that the engine emits what it emitted before -- if seat behaviour changed too,
 * two things moved at once and nobody can say which one moved the run.
 *
 * The expected values below are HAND-WRITTEN from the pre-refactor code, not
 * derived from the orders. Deriving them would prove only that the compile
 * agrees with itself, which is the shape of assertion that let a `dontAsk` that
 * never reached CC pass its own test for the life of the feature.
 */
describe('compiling card + order emits EXACTLY what the hardcoded seats emitted', () => {
  const planner = () =>
    planPlannerSpawn(CTX, {
      projectUri: CTX.project,
      projectRoot: CTX.projectRoot,
      run: { ...RUN, digest: 'x' },
      plan: PLAN,
      cardLines: [],
      epicBody: '# epic',
    })

  /** One seat, and the exact plan it produced before orders existed. */
  interface SeatCase {
    seat: string
    plan: () => EpicSpawnPlan
    role: EpicRole
    name: string
    worktree?: string
    cardId?: string
  }

  const SEATS: SeatCase[] = [
    { seat: 'overseer', plan: overseer, role: 'overseer', name: '[werk-epic] overseer g4' },
    { seat: 'planner', plan: planner, role: 'overseer', name: '[werk-epic] planner overseer g4' },
    {
      seat: 'implementer',
      plan: () => planImplementerSpawn(CTX, 't1'),
      role: 'implementer',
      name: '[werk-epic] t1 g4',
      worktree: 'epic/werk-epic/t1',
      cardId: 't1',
    },
    {
      seat: 'verifier',
      plan: () => planVerifierSpawn(CTX, 't1'),
      role: 'verifier',
      name: '[werk-epic] verify t1 g4',
      worktree: 'epic/werk-epic/verify-t1',
      cardId: 't1',
    },
  ]

  test.each(SEATS)('$seat: every field except the prompt is byte-identical', s => {
    const { prompt, ...rest } = s.plan()
    expect(prompt.length).toBeGreaterThan(0)
    expect(rest).toEqual({
      cwd: CTX.project,
      headless: true,
      adHoc: true,
      permissionMode: 'bypassPermissions',
      settingsInline: buildEpicWorkerSettings(s.role, undefined),
      epic: { epicId: 'werk-epic', role: s.role, gen: 4, ...(s.cardId ? { cardId: s.cardId } : {}) },
      name: s.name,
      failOnNameCollision: false,
      ...(s.worktree ? { worktree: s.worktree } : {}),
    })
  })

  /**
   * `order@1` can pin a model, an effort tier, an agent, a per-seat budget and
   * an MCP config, and no shipped order does. An extra key here is not cosmetic:
   * `spawn-launch-config.test.ts` walks the plan through the real spawn schema,
   * so a caps key that appears is a value that reaches CC.
   */
  test.each(SEATS)('$seat: no per-order cap leaked into the spawn', s => {
    const keys = Object.keys(s.plan())
    for (const cap of ['model', 'effort', 'agent', 'maxBudgetUsd', 'mcpConfigPath']) {
      expect(keys).not.toContain(cap)
    }
  })

  /**
   * The order NAMES its prompt builder rather than referencing one (four
   * builders, four context types). That declaration is only worth anything if
   * something checks it against the call the planner actually makes.
   */
  test('each order’s declared prompt builder is the one the planner calls', () => {
    expect(EPIC_ORDERS.implementer.prompt).toBe('implementer')
    expect(planImplementerSpawn(CTX, 't1').prompt).toBe(
      buildImplementerPrompt({
        projectUri: CTX.project,
        projectRoot: CTX.projectRoot,
        epicId: CTX.epicId,
        cardId: 't1',
        branch: worktreeBranch('epic/werk-epic/t1'),
        base: 'main',
        dependsOn: [],
      }),
    )
    expect(EPIC_ORDERS.verifier.prompt).toBe('guard')
    expect(planVerifierSpawn(CTX, 't1').prompt).toBe(
      buildGuardPrompt({ projectUri: CTX.project, projectRoot: CTX.projectRoot, cardId: 't1' }),
    )
  })
})

/**
 * STEP 3, at the seam the engine actually uses.
 *
 * `order-caps.test.ts` proves the composition; this proves the PLANNER is wired
 * to it -- that a seat whose order asks for more privilege than the caller holds
 * fails at plan time instead of being quietly dispatched at whatever the caller
 * happened to hold.
 */
describe('an order can never widen the trust of whoever runs it', () => {
  test('the shipped seats plan fine under the benevolent default', () => {
    expect(() => planImplementerSpawn(CTX, 't1')).not.toThrow()
    expect(() => planVerifierSpawn({ ...CTX, trustLevel: 'benevolent' }, 't1')).not.toThrow()
  })

  test('bypassPermissions from a merely-trusted caller is REFUSED, not downgraded', () => {
    const ctx: EpicSpawnCtx = { ...CTX, trustLevel: 'trusted' }
    expect(() => planImplementerSpawn(ctx, 't1')).toThrow(OrderCapsError)
    expect(() => planImplementerSpawn(ctx, 't1')).toThrow(/bypassPermissions mode requires benevolent trust/)
  })

  test('the refusal names the order, so a log line says WHICH seat asked', () => {
    expect(() => planOverseerSpawn({ ...CTX, trustLevel: 'untrusted' }, PROMPT_CTX)).toThrow(/OVERSEER@1/)
  })
})
