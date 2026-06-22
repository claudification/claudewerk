/**
 * NIGHTSHIFT ACT-ON-RESULTS spawn builder (plan §4).
 *
 * Turns one ACT button on the Result screen into a worktree-correct
 * `SpawnRequest` for an ORDINARY fleet agent pointed at `.nightshift/latest`.
 * The prompt (nightshift-act-prompts.ts) tells the agent to grep the task
 * frontmatter and act; this module resolves the cwd, labels the job, and runs
 * the worktree-correctness guard so we can never repeat the cwd=main+worktree
 * bug.
 *
 * The act agents are NOT night-run workers: they run AT the project root (main
 * checkout) because integrate/bundle inherently operate on main, which is exactly
 * where the covenant says a fast-forward merge happens. No worktree is intended,
 * so the guard is a no-op pass -- but we still call it so any future caller that
 * DOES pass a worktree gets validated.
 */

import { buildActPrompt, type NightshiftActKind } from './nightshift-act-prompts'
import { parseProjectUri } from './project-uri'
import { assertWorktreeCorrectSpawn } from './worktree-correct'

export type { NightshiftActKind } from './nightshift-act-prompts'

/** Human labels for the sidebar + dashboard, one per act kind. */
const LABELS: Record<NightshiftActKind, string> = {
  integrate: 'integrate green',
  test: 'test all',
  bundle: 'bundle',
  discard: 'discard',
  freeform: 'freeform',
}

export interface BuildActSpawnInput {
  kind: NightshiftActKind
  /** Canonical project URI the run belongs to (claude://sentinel/abs/path). */
  projectUri: string
  /** The run to act on, YYYY-MM-DD (from the Result snapshot's run.runId). */
  runId: string
  /** Optional task-id filter: per-card acts, targeted bundle/discard. */
  taskIds?: string[]
  /** Freeform instruction (kind=freeform) or the discard reason (kind=discard). */
  freeform?: string
}

/**
 * The subset of SpawnRequest fields an act spawn fills in. The caller splats this
 * into `sendSpawnRequest` (web) so the rest of the spawn defaults (backend,
 * transport, profile selection) apply normally.
 */
export interface ActSpawn {
  cwd: string
  /** Present only when an act intends a worktree (none do today -> undefined). */
  worktree?: string
  prompt: string
  name: string
  description: string
  headless: boolean
}

/** Build the worktree-correct spawn for one ACT button. */
export function buildActSpawn(input: BuildActSpawnInput): ActSpawn {
  const { kind, projectUri, runId } = input
  const projectRoot = parseProjectUri(projectUri).path
  if (!projectRoot || projectRoot === '/' || projectRoot === '*') {
    throw new Error(`nightshift act: cannot resolve a project root from URI ${JSON.stringify(projectUri)}`)
  }

  // Act agents run at the project root (main checkout): integrate/bundle operate
  // ON main. No worktree intended -- assert anyway to lock the invariant.
  const cwd = projectRoot
  assertWorktreeCorrectSpawn({ cwd, worktreeName: undefined })

  const prompt = buildActPrompt(kind, {
    projectUri,
    projectRoot,
    runId,
    taskIds: input.taskIds,
    freeform: input.freeform,
  })

  const scope = input.taskIds?.length ? ` #${input.taskIds.join(',#')}` : ''
  return {
    cwd,
    prompt,
    name: `act:${LABELS[kind]}${scope}`,
    description: `Nightshift act-on-results (${kind}) for run ${runId}${scope}`,
    headless: true,
  }
}
