/**
 * The spawn payload for one epic seat -- pure, so what a role is ALLOWED to do
 * is inspectable without spawning anything.
 *
 * This is where the four seats stop being vocabulary and start being different
 * processes: a different prompt, a different settings blob (the mute), and a
 * different worktree. The role tag rides along on `epic` for grouping, but
 * nothing downstream re-reads it to grant a capability -- if the mute is missing
 * here it is missing at runtime, which is exactly the property the tests assert.
 *
 * WHAT A SEAT *IS* NO LONGER LIVES IN THIS FILE. It lives in `epic-orders.ts`
 * as four `order@1` artifacts, and this file COMPILES them:
 *
 *     CARD (what to build) + ORDER (who builds it) => the dispatched seat
 *
 * The werk-planners below are the compile sites. Their exported signatures are
 * unchanged and so is every byte they emit -- the orders were written to
 * reproduce what was hardcoded here, and `epic-spawn-plan.test.ts` is what says
 * so. What changed is that a fifth seat is now a file rather than an edit to
 * this one.
 *
 * Shape mirrors the nightshift dispatch call (`dispatchSpawn` input) so the two
 * engines stay one engine.
 */

import { EPIC_ORDERS, orderRole } from '../shared/epic-orders'
import { buildWerkMasterPrompt, type WerkMasterPromptCtx } from '../shared/epic-prompt-werk-master'
import { buildWerkPlannerPrompt, type WerkPlannerPromptCtx } from '../shared/epic-prompt-werk-planner'
import { buildWerkVerifierPrompt } from '../shared/epic-prompt-werk-verifier'
import { buildWerkWorkerPrompt } from '../shared/epic-prompt-werk-worker'
import type { EpicLaunchTag } from '../shared/epic-run-types'
import { buildEpicWorkerSettings } from '../shared/epic-worker-permissions'
import { fnv1aHex } from '../shared/fnv1a'
import type { Order, OrderCaps } from '../shared/order'
import {
  type ComposedOrderCaps,
  composeOrderCapsOrThrow,
  internalOrderCaller,
  type OrderCapBase,
} from '../shared/order-caps'
import type { TrustLevel } from '../shared/spawn-permissions'
import type { UnattendedPermissionConfig } from '../shared/unattended-permissions'
import { worktreeBranch } from '../shared/worktree-path'

/**
 * THE PERMISSION MODE, said out loud.
 *
 * This used to declare `dontAsk` and it was never true: every seat is `adHoc`,
 * and `resolveSpawnConfig` rewrites an ad-hoc spawn's mode to `bypassPermissions`
 * unconditionally (spawn-defaults.ts). So the declared value never reached CC,
 * the test asserting it asserted a value with no effect, and anyone reading this
 * file believed epic workers were allowlist-constrained -- and would either
 * "widen the allowlist" to fix a problem that did not exist, or delete the ad-hoc
 * rule and silently take every epic run's permissions away.
 *
 * Declaring it honestly is also the correct mode on its merits. `dontAsk` denies
 * anything not on `permissions.allow`, and you cannot enumerate what a coding
 * agent needs -- DEFAULT_ALLOW does not carry `git merge`, `git rebase` or
 * `git fetch`, all three of which the WERK-MASTER is explicitly instructed to run.
 * An allowlist is a treadmill; the deny-floor is a wall.
 *
 * WHAT STILL STOPS A RUNAWAY, none of which is the permission mode:
 *   - the deny-floor PreToolUse hook (force-push, push to main, sudo, kill,
 *     external send, rm outside the worktree). A hook runs in EVERY mode.
 *   - the mute hook, for every seat that is not the werk-master.
 *   - worktree isolation: worst case a worker dirties its own branch.
 *
 * THE VALUE NOW COMES FROM THE ORDER, not from this file. All four shipped
 * orders declare `bypassPermissions`, so the emitted value is what it always
 * was -- but the type is the order's, because narrowing ONE seat is now a
 * one-line edit to that seat's order and must not require widening a type here
 * to express it. `order-caps.ts` guarantees the direction: an order can move a
 * seat DOWN the privilege ladder and never up.
 */
export type EpicPermissionMode = NonNullable<OrderCaps['permissionMode']>

export interface EpicSpawnPlan {
  cwd: string
  prompt: string
  headless: true
  /** Single-prompt worker: exit at end of turn rather than idling until the
   *  watchdog reaps it. Same reasoning as the nightshift worker. */
  adHoc: true
  worktree?: string
  /**
   * A SEAT DOES NOT INTEGRATE ITSELF. Present (and `false`) for exactly the
   * seats that have a worktree.
   *
   * The order says the loop is worker -> verifier -> WERK-MASTER MERGES, and
   * the loop did not obey: four cards in one run reached `main` as bare
   * fast-forwards with no werk-master in the path, one of them eight seconds
   * after its werk-verifier was dispatched. Nobody was rogue -- the ad-hoc
   * anti-stranding machinery in the agent host fires on session exit and has no
   * idea a verdict exists. This flag is a seat telling it so. Both the prompt
   * fragment and the exit-time fast-forward read this ONE field; see
   * `../shared/worktree-mergeback.ts`.
   *
   * ABSENT for the werk-master and werk-planner, which have no worktree and no
   * branch of their own -- they merge ON main, which is the whole point.
   */
  worktreeMergeBack?: false
  permissionMode: EpicPermissionMode
  settingsInline: Record<string, unknown>
  epic: EpicLaunchTag
  name: string
  /**
   * A WERK seat would rather be renamed than refused. The generation below
   * already makes a retry a different name in the normal case; this covers the
   * one it cannot -- two long sibling card ids that truncate to the same 60
   * characters at the same generation.
   */
  failOnNameCollision: false
  /**
   * PER-SEAT CAPS, from the order, composed through `order-caps.ts`.
   *
   * `model` and `effort` are PRESENT for every seat the engine dispatches --
   * `werk-seat-model-policy` made every order declare both, so no seat resolves
   * its tier from a machine's spawn default any more. The other three are absent
   * because no shipped epic order sets them, and an absent key is not the same as
   * an explicit `undefined` here: `spawn-launch-config.test.ts` asserts that
   * every field the plan sets survives the spawn schema, so a key that appears
   * must be a key the wire carries. Each of these is a real `SpawnRequest` field.
   */
  model?: string
  effort?: OrderCaps['effort']
  agent?: string
  maxBudgetUsd?: number
  mcpConfigPath?: string
}

export interface EpicSpawnCtx {
  /** Project URI. Informational to the broker, resolved by the sentinel. */
  project: string
  /** Absolute project root, for prompts that must name a file path. */
  projectRoot: string
  epicId: string
  gen: number
  /** Per-project extra allow/deny rules layered on the unattended defaults. */
  permissions?: UnattendedPermissionConfig
  /**
   * Trust the ORDER's caps are composed against. Defaults to `benevolent`.
   *
   * WHY THE DEFAULT IS THE PERMISSIVE ONE, said out loud: this is a PLANNING
   * step, and the real gate runs later. `epic-beat-actions.ts` hands the plan to
   * `dispatchSpawn`, which evaluates the caller's ACTUAL `SpawnCallerContext`
   * through the very same `evaluateSpawnPermission` -- so a seat a non-benevolent
   * project may not spawn is refused there, exactly as it was before orders
   * existed. Composing at plan time is the ADDITIONAL narrowing layer that
   * matters when an order did not come from this repo (`werk-work-orders-share`),
   * and a caller that knows its trust can pass it here to get the refusal early.
   */
  trustLevel?: TrustLevel
}

/**
 * `sanitizeConversationName` truncates to this, and the spawn gate then refuses
 * a name any conversation has EVER used -- including ended ones. So a name built
 * past this length is not merely trimmed, it is trimmed into somebody else's.
 */
const NAME_BUDGET = 60

/**
 * A seat's conversation name: readable, and UNIQUE PER ATTEMPT.
 *
 * The names used to be purely deterministic -- `[epic X] <cardId>` -- and the
 * spawn gate enforces global uniqueness across every conversation that has ever
 * existed, ended ones included. So the FIRST dispatch of a card claimed the name
 * forever and every retry after that died on
 * `Session name "..." is already in use`. A bounced card could never be
 * re-dispatched, and a run that tried filled the broker log with the refusal
 * every 45 seconds. The generation is what makes a second attempt a second name.
 *
 * The generation goes at the END and the CARD ID is what gets shortened, because
 * truncation happens from the right: put the discriminator in the tail and the
 * truncation eats the very thing that makes the name unique.
 */
function seatName(epicId: string, gen: number, cardId: string | undefined, prefix = ''): string {
  const suffix = ` g${gen}`
  const head = `[${epicId}] ${prefix}`
  if (!cardId) return `${head}werk-master${suffix}`.slice(0, NAME_BUDGET)
  const room = NAME_BUDGET - head.length - suffix.length
  return `${head}${cardId.slice(0, Math.max(1, room))}${suffix}`
}

/**
 * Claude Code refuses a `--worktree` name over this and exits 1 in about a
 * second, before anything reaches the transcript. THE 2026-08-20 INCIDENT: the
 * werk-verifier for `epic-engine-baton-window-relitigates-settles` asked for a
 * 73-character branch and died with
 * `ERR Error creating worktree: Invalid worktree name: must be 64 characters or
 * fewer (got 73)` -- one line, in CC's headless log, which nothing forwarded.
 *
 * The conversation NAME has had a budget since the day names collided
 * (`NAME_BUDGET`). The branch never did, and it is the LONGER of the two by
 * construction: `verify-` plus the whole card id, untruncated.
 */
const BRANCH_BUDGET = 64

/** Length of the hash kept when a branch has to be shortened. Long enough that
 *  two sibling card ids sharing a 50-character prefix do not collide, short
 *  enough that what survives of the card id is still readable. */
const BRANCH_HASH_LEN = 7

/** How much of the epic id survives a shortened branch. Only ever applied when
 *  the branch overflows, so a normal epic id is untouched -- but without it a
 *  long enough epic id eats the entire budget on its own and the cap becomes a
 *  promise this function cannot keep. */
const EPIC_SEGMENT_BUDGET = 24

/**
 * A seat's branch: `epic/<epicId>/[verify-]<cardId>`, shortened to fit
 * `BRANCH_BUDGET` when it has to be.
 *
 * Two rules, and both are essential:
 *
 *   - DETERMINISTIC. The same card always resolves to the same branch, so a
 *     re-dispatch after a bounce reuses its worktree instead of forking a
 *     second one. No generation in here, unlike the conversation name.
 *   - COLLIDING SIBLINGS STAY DISTINCT. Truncation alone would map
 *     `...-relitigates-settles` and `...-relitigates-settled` onto one branch,
 *     and two werk-workers would then write to the same tree -- the one thing
 *     worktree isolation exists to prevent. The tail hash is over the FULL
 *     original, so it differs wherever the ids do.
 */
function seatBranch(epicId: string, cardId: string, prefix = ''): string {
  const full = `epic/${epicId}/${prefix}${cardId}`
  if (full.length <= BRANCH_BUDGET) return full
  const suffix = `-${fnv1aHex(full).slice(0, BRANCH_HASH_LEN)}`
  const head = `epic/${epicId.slice(0, EPIC_SEGMENT_BUDGET)}/${prefix}`
  const room = BRANCH_BUDGET - head.length - suffix.length
  return `${head}${cardId.slice(0, Math.max(1, room))}${suffix}`
}

/**
 * The order's deny rules, folded onto the project's own.
 *
 * ADD-ONLY, and `order@1` has no `allow` field at all, so this is the only
 * direction that exists. When no order contributes a deny -- which is every
 * seat today -- the project's config is passed through by reference and
 * `buildEpicWorkerSettings` sees exactly what it saw before.
 */
function seatPermissions(ctx: EpicSpawnCtx, caps: ComposedOrderCaps): UnattendedPermissionConfig | undefined {
  if (!caps.deny) return ctx.permissions
  return { ...ctx.permissions, deny: caps.deny }
}

/** Only ever set a caps key the composition produced -- see `EpicSpawnPlan`. */
function capsFields(caps: ComposedOrderCaps): Partial<EpicSpawnPlan> {
  const out: Partial<EpicSpawnPlan> = {}
  if (caps.model !== undefined) out.model = caps.model
  if (caps.effort !== undefined) out.effort = caps.effort
  if (caps.agent !== undefined) out.agent = caps.agent
  if (caps.maxBudgetUsd !== undefined) out.maxBudgetUsd = caps.maxBudgetUsd
  if (caps.mcpConfigPath !== undefined) out.mcpConfigPath = caps.mcpConfigPath
  return out
}

/**
 * THE COMPILE STEP: card + order -> everything about the seat except its prompt.
 *
 * The prompt is left to the caller because the four builders take four
 * different context types; the order NAMES its builder (`order.prompt`) so the
 * artifact is still readable, and `epic-orders.test.ts` asserts the declaration
 * and the call agree. A union-typed dispatch here would buy a cast and nothing
 * else.
 */
function compileSeat(
  ctx: EpicSpawnCtx,
  order: Order,
  cardId?: string,
  base: OrderCapBase = {},
): Omit<EpicSpawnPlan, 'prompt'> {
  const caps = composeOrderCapsOrThrow(
    order,
    { ...base, ...(ctx.permissions?.deny ? { deny: ctx.permissions.deny } : {}) },
    internalOrderCaller(ctx.trustLevel),
  )
  const role = orderRole(order)
  const worktree = order.worktree && cardId ? seatBranch(ctx.epicId, cardId, order.worktree.prefix) : undefined
  return {
    cwd: ctx.project,
    headless: true,
    adHoc: true,
    permissionMode: caps.permissionMode ?? 'bypassPermissions',
    settingsInline: buildEpicWorkerSettings(role, seatPermissions(ctx, caps)),
    epic: { epicId: ctx.epicId, role, gen: ctx.gen, ...(cardId ? { cardId } : {}) },
    name: seatName(ctx.epicId, ctx.gen, cardId, order.namePrefix),
    failOnNameCollision: false,
    // Derived from `worktree`, not declared per-order, because the two can never
    // legitimately disagree: a seat with an isolated branch is a seat somebody
    // else merges, and a seat without one has nothing to fast-forward FROM.
    ...(worktree ? { worktree, worktreeMergeBack: false as const } : {}),
    ...capsFields(caps),
  }
}

/**
 * The WERK-MASTER. No worktree: it reads the board, answers questions and merges on
 * main -- giving it an isolated checkout would hide the very state it exists to
 * judge. It is also the only seat whose settings leave the human channels open.
 */
export function planWerkMasterSpawn(ctx: EpicSpawnCtx, promptCtx: WerkMasterPromptCtx): EpicSpawnPlan {
  return {
    ...compileSeat(ctx, EPIC_ORDERS['werk-master']),
    prompt: buildWerkMasterPrompt(promptCtx),
  }
}

/**
 * THE WERK-PLANNER -- generation 0. The WERK-MASTER SEAT with a different prompt.
 *
 * Same role tag on purpose, and it is not laziness: `werkMasterAlive` is what stops
 * the engine dispatching underneath a live supervisor, and a planning generation
 * needs exactly that guard. Tagging it `werk-planner` would have made it invisible to
 * the check whose whole job is to hold the beat -- so the engine would race the
 * pass that exists to tell it what may safely run at once.
 *
 * No worktree, for the werk-master's reason: it edits the board, which lives on
 * main, and an isolated checkout would hide the state it exists to fix.
 */
export function planWerkPlannerSpawn(ctx: EpicSpawnCtx, promptCtx: WerkPlannerPromptCtx): EpicSpawnPlan {
  return {
    ...compileSeat(ctx, EPIC_ORDERS['werk-planner']),
    prompt: buildWerkPlannerPrompt(promptCtx),
  }
}

/**
 * A card id -> the git branch its work is on.
 *
 * TWO transforms, and skipping either one names a branch that does not exist:
 * `seatBranch` is what named the card's worktree (including the hash shortening
 * a long card id gets), and `worktreeBranch` is the `worktree-` prefix
 * `scripts/worktree-create.sh` puts on the branch it cuts. The seat plan carries
 * the WORKTREE name, which is the un-prefixed half -- so a prompt that quoted
 * `plan.worktree` at a werk-worker would hand it an unmergeable ref.
 *
 * EXPORTED because the promise ledger asks the same question from the other end:
 * given a settled card, which branch's commits delivered it. Two callers
 * deriving that string independently is exactly how one of them ends up looking
 * up a branch nobody ever cut.
 */
export function cardBranch(epicId: string, cardId: string): string {
  return worktreeBranch(seatBranch(epicId, cardId))
}

/**
 * An WERK-WORKER. Own worktree, own branch, muted.
 *
 * TWO NAMES, NOT ONE, and they differ by exactly the `worktree-` prefix:
 * `plan.worktree` is the worktree NAME (what CC is handed, what the 64-character
 * cap is measured against), and the prompt quotes the BRANCH that
 * `scripts/worktree-create.sh` actually cuts. Passing one string as both told an
 * werk-worker to work on `epic/<epic>/<card>` while `git branch --show-current`
 * in its own tree said `worktree-epic/<epic>/<card>` -- measured on this very
 * fix's worktree. Harmless while the branch was never named for a git command;
 * not harmless once `dependsOn` put a SECOND, correctly-prefixed branch ref in
 * the same prompt, because a werk-worker that trusts rule 1's spelling then
 * merges a ref that does not resolve.
 *
 * `dependsOn` is the card's own `depends_on`, passed through so the prompt can
 * order a base check. It is only ever data here: this function does not consult
 * it, gate on it, or change the base ref because of it -- readiness stays exactly
 * where it was (see epic-implementer-base-lacks-deps).
 *
 * `model` is the card's `model:` hint, and it arrives ALREADY CLAMPED against
 * `WERK-WORKER@1`'s cap -- the clamp lives at the dispatch site because that is
 * where the log line has somewhere to go (card-model.ts). Passing it as the
 * composition's base is then correct rather than dangerous: an explicit base
 * wins over an order's selection cap, which is exactly what a value that has
 * already been narrowed is entitled to do. STILL OMITTED BY THE EPIC ENGINE,
 * which does not thread the card's hint through `spawnForCard` at all -- so an
 * epic-dispatched werk-worker runs `WERK-WORKER@1`'s own tier no matter what the
 * refiner wrote on the card. That is a gap, not a decision, and it belongs to
 * `werk-epic-engine-spends-card-model-hint` rather than to the card that baked
 * the tiers.
 */
export function planWerkWorkerSpawn(
  ctx: EpicSpawnCtx,
  cardId: string,
  baseRef = 'main',
  dependsOn: readonly string[] = [],
  model?: string,
): EpicSpawnPlan {
  const seat = compileSeat(ctx, EPIC_ORDERS['werk-worker'], cardId, model ? { model } : {})
  return {
    ...seat,
    prompt: buildWerkWorkerPrompt({
      projectUri: ctx.project,
      projectRoot: ctx.projectRoot,
      epicId: ctx.epicId,
      cardId,
      branch: worktreeBranch(seat.worktree as string),
      base: baseRef,
      dependsOn: dependsOn.map(id => ({ id, branch: cardBranch(ctx.epicId, id) })),
    }),
  }
}

/**
 * A WERK-VERIFIER, using the Guard prompt that has existed unused since the quest
 * engine landed. Its scratch worktree is its own, and it is given the card plus
 * the diff -- never the werk-worker's conversation. A reviewer that reads the
 * coder's reasoning inherits the coder's blind spots (werk-done-gate).
 */
export function planWerkVerifierSpawn(ctx: EpicSpawnCtx, cardId: string): EpicSpawnPlan {
  return {
    ...compileSeat(ctx, EPIC_ORDERS['werk-verifier'], cardId),
    // `epicId` is what switches the seat-lease order on: this Guard is a WERK
    // seat, unlike the quest engine's, so `epic_seat` will answer it.
    prompt: buildWerkVerifierPrompt({
      projectUri: ctx.project,
      projectRoot: ctx.projectRoot,
      cardId,
      epicId: ctx.epicId,
    }),
  }
}
