/**
 * The spawn payload for one epic seat -- pure, so what a role is ALLOWED to do
 * is inspectable without spawning anything.
 *
 * This is where the three roles stop being vocabulary and start being different
 * processes: a different prompt, a different settings blob (the mute), and a
 * different worktree. The role tag rides along on `epic` for grouping, but
 * nothing downstream re-reads it to grant a capability -- if the mute is missing
 * here it is missing at runtime, which is exactly the property the tests assert.
 *
 * Shape mirrors the nightshift dispatch call (`dispatchSpawn` input) so the two
 * engines stay one engine.
 */

import { buildImplementerPrompt } from '../shared/epic-prompt-implementer'
import { buildOverseerPrompt, type OverseerPromptCtx } from '../shared/epic-prompt-overseer'
import { buildPlannerPrompt, type PlannerPromptCtx } from '../shared/epic-prompt-planner'
import type { EpicLaunchTag, EpicRole } from '../shared/epic-run-types'
import { buildEpicWorkerSettings } from '../shared/epic-worker-permissions'
import { fnv1aHex } from '../shared/fnv1a'
import { buildGuardPrompt } from '../shared/guard-prompt'
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
 * `git fetch`, all three of which the OVERSEER is explicitly instructed to run.
 * An allowlist is a treadmill; the deny-floor is a wall.
 *
 * WHAT STILL STOPS A RUNAWAY, none of which is the permission mode:
 *   - the deny-floor PreToolUse hook (force-push, push to main, sudo, kill,
 *     external send, rm outside the worktree). A hook runs in EVERY mode.
 *   - the mute hook, for every seat that is not the overseer.
 *   - worktree isolation: worst case a worker dirties its own branch.
 */
export type EpicPermissionMode = 'bypassPermissions'

export interface EpicSpawnPlan {
  cwd: string
  prompt: string
  headless: true
  /** Single-prompt worker: exit at end of turn rather than idling until the
   *  watchdog reaps it. Same reasoning as the nightshift worker. */
  adHoc: true
  worktree?: string
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
  if (!cardId) return `${head}overseer${suffix}`.slice(0, NAME_BUDGET)
  const room = NAME_BUDGET - head.length - suffix.length
  return `${head}${cardId.slice(0, Math.max(1, room))}${suffix}`
}

/**
 * Claude Code refuses a `--worktree` name over this and exits 1 in about a
 * second, before anything reaches the transcript. THE 2026-08-20 INCIDENT: the
 * verifier for `epic-engine-baton-window-relitigates-settles` asked for a
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
 *     and two implementers would then write to the same tree -- the one thing
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

function base(
  ctx: EpicSpawnCtx,
  role: EpicRole,
  cardId: string | undefined,
  name: string,
): Omit<EpicSpawnPlan, 'prompt'> {
  return {
    cwd: ctx.project,
    headless: true,
    adHoc: true,
    permissionMode: 'bypassPermissions',
    settingsInline: buildEpicWorkerSettings(role, ctx.permissions),
    epic: { epicId: ctx.epicId, role, gen: ctx.gen, ...(cardId ? { cardId } : {}) },
    name,
    failOnNameCollision: false,
  }
}

/**
 * The OVERSEER. No worktree: it reads the board, answers questions and merges on
 * main -- giving it an isolated checkout would hide the very state it exists to
 * judge. It is also the only seat whose settings leave the human channels open.
 */
export function planOverseerSpawn(ctx: EpicSpawnCtx, promptCtx: OverseerPromptCtx): EpicSpawnPlan {
  return {
    ...base(ctx, 'overseer', undefined, seatName(ctx.epicId, ctx.gen, undefined)),
    prompt: buildOverseerPrompt(promptCtx),
  }
}

/**
 * THE PLANNER -- generation 0. The OVERSEER SEAT with a different prompt.
 *
 * Same role tag on purpose, and it is not laziness: `overseerAlive` is what stops
 * the engine dispatching underneath a live supervisor, and a planning generation
 * needs exactly that guard. Tagging it `planner` would have made it invisible to
 * the check whose whole job is to hold the beat -- so the engine would race the
 * pass that exists to tell it what may safely run at once.
 *
 * No worktree, for the overseer's reason: it edits the board, which lives on
 * main, and an isolated checkout would hide the state it exists to fix.
 */
export function planPlannerSpawn(ctx: EpicSpawnCtx, promptCtx: PlannerPromptCtx): EpicSpawnPlan {
  return {
    ...base(ctx, 'overseer', undefined, seatName(ctx.epicId, ctx.gen, undefined, 'planner ')),
    prompt: buildPlannerPrompt(promptCtx),
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
 * `plan.worktree` at an implementer would hand it an unmergeable ref.
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
 * An IMPLEMENTER. Own worktree, own branch, muted.
 *
 * TWO NAMES, NOT ONE, and they differ by exactly the `worktree-` prefix:
 * `plan.worktree` is the worktree NAME (what CC is handed, what the 64-character
 * cap is measured against), and the prompt quotes the BRANCH that
 * `scripts/worktree-create.sh` actually cuts. Passing one string as both told an
 * implementer to work on `epic/<epic>/<card>` while `git branch --show-current`
 * in its own tree said `worktree-epic/<epic>/<card>` -- measured on this very
 * fix's worktree. Harmless while the branch was never named for a git command;
 * not harmless once `dependsOn` put a SECOND, correctly-prefixed branch ref in
 * the same prompt, because an implementer that trusts rule 1's spelling then
 * merges a ref that does not resolve.
 *
 * `dependsOn` is the card's own `depends_on`, passed through so the prompt can
 * order a base check. It is only ever data here: this function does not consult
 * it, gate on it, or change the base ref because of it -- readiness stays exactly
 * where it was (see epic-implementer-base-lacks-deps).
 */
export function planImplementerSpawn(
  ctx: EpicSpawnCtx,
  cardId: string,
  baseRef = 'main',
  dependsOn: readonly string[] = [],
): EpicSpawnPlan {
  const worktree = seatBranch(ctx.epicId, cardId)
  return {
    ...base(ctx, 'implementer', cardId, seatName(ctx.epicId, ctx.gen, cardId)),
    worktree,
    prompt: buildImplementerPrompt({
      projectUri: ctx.project,
      projectRoot: ctx.projectRoot,
      epicId: ctx.epicId,
      cardId,
      branch: worktreeBranch(worktree),
      base: baseRef,
      dependsOn: dependsOn.map(id => ({ id, branch: cardBranch(ctx.epicId, id) })),
    }),
  }
}

/**
 * A VERIFIER, using the Guard prompt that has existed unused since the quest
 * engine landed. Its scratch worktree is its own, and it is given the card plus
 * the diff -- never the implementer's conversation. A reviewer that reads the
 * coder's reasoning inherits the coder's blind spots (werk-done-gate).
 */
export function planVerifierSpawn(ctx: EpicSpawnCtx, cardId: string): EpicSpawnPlan {
  return {
    ...base(ctx, 'verifier', cardId, seatName(ctx.epicId, ctx.gen, cardId, 'verify ')),
    worktree: seatBranch(ctx.epicId, cardId, 'verify-'),
    prompt: buildGuardPrompt({ projectUri: ctx.project, projectRoot: ctx.projectRoot, cardId }),
  }
}
