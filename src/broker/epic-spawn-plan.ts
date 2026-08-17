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
import type { EpicLaunchTag, EpicRole } from '../shared/epic-run-types'
import { buildEpicWorkerSettings } from '../shared/epic-worker-permissions'
import { buildGuardPrompt } from '../shared/guard-prompt'
import type { UnattendedPermissionConfig } from '../shared/unattended-permissions'

export interface EpicSpawnPlan {
  cwd: string
  prompt: string
  headless: true
  /** Single-prompt worker: exit at end of turn rather than idling until the
   *  watchdog reaps it. Same reasoning as the nightshift worker. */
  adHoc: true
  worktree?: string
  permissionMode: 'dontAsk'
  settingsInline: Record<string, unknown>
  epic: EpicLaunchTag
  name: string
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
    permissionMode: 'dontAsk',
    settingsInline: buildEpicWorkerSettings(role, ctx.permissions),
    epic: { epicId: ctx.epicId, role, gen: ctx.gen, ...(cardId ? { cardId } : {}) },
    name: name.slice(0, 80),
  }
}

/**
 * The OVERSEER. No worktree: it reads the board, answers questions and merges on
 * main -- giving it an isolated checkout would hide the very state it exists to
 * judge. It is also the only seat whose settings leave the human channels open.
 */
export function planOverseerSpawn(ctx: EpicSpawnCtx, promptCtx: OverseerPromptCtx): EpicSpawnPlan {
  return {
    ...base(ctx, 'overseer', undefined, `[epic ${ctx.epicId}] overseer gen ${ctx.gen}`),
    prompt: buildOverseerPrompt(promptCtx),
  }
}

/** An IMPLEMENTER. Own worktree, own branch, muted. */
export function planImplementerSpawn(ctx: EpicSpawnCtx, cardId: string, baseRef = 'main'): EpicSpawnPlan {
  const branch = `epic/${ctx.epicId}/${cardId}`
  return {
    ...base(ctx, 'implementer', cardId, `[epic ${ctx.epicId}] ${cardId}`),
    worktree: branch,
    prompt: buildImplementerPrompt({
      projectUri: ctx.project,
      projectRoot: ctx.projectRoot,
      epicId: ctx.epicId,
      cardId,
      branch,
      base: baseRef,
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
    ...base(ctx, 'verifier', cardId, `[epic ${ctx.epicId}] verify ${cardId}`),
    worktree: `epic/${ctx.epicId}/verify-${cardId}`,
    prompt: buildGuardPrompt({ projectUri: ctx.project, projectRoot: ctx.projectRoot, cardId }),
  }
}
