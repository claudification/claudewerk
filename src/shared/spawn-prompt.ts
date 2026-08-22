/**
 * Canonical prompt assembly for spawn requests.
 *
 * Used by:
 * - Dashboard RunTaskDialog (web/src/components/project-board.tsx)
 * - web/src/lib/task-scoring.ts (re-exports buildTaskPrompt)
 * - Agent Host /workon slash command (when applicable)
 *
 * Single source of truth for:
 * - AUTO_COMMIT_INSTRUCTIONS (auto-commit suffix)
 * - WORKTREE_MERGEBACK_INSTRUCTIONS (worktree merge-back suffix)
 * - <project-task> agent host format
 */

import { type TaskMode, taskMode } from './task-modes'
import { mergeBackInstructionsWanted } from './worktree-mergeback'

export type TaskMeta = {
  slug: string
  title: string
  status: string
  priority?: string
  tags: string[]
  bodyPreview?: string
  body?: string
}

export const AUTO_COMMIT_INSTRUCTIONS = '\n\nWhen you are done, commit all changes with a descriptive commit message.'

/**
 * Never hand agents a raw `git fetch . HEAD:main` here. git 2.54 refuses to move
 * a ref checked out in any working tree, so that command fails for every agent,
 * every time, and strands the branch. `worktree-finish.sh` owns the merge-back
 * (see the `ff_main` helper) -- point at the script, not at git plumbing, so
 * this text can never drift from the tool again.
 */
export const WORKTREE_MERGEBACK_INSTRUCTIONS =
  '\n\nIMPORTANT - WORKTREE MERGE-BACK:\nYou are working in a git worktree (isolated branch). Before finishing:\n1. Commit all changes\n2. Merge back to main: run `bash scripts/worktree-finish.sh`\n3. If rebase conflicts occur, resolve them, run `git rebase --continue`, then re-run the script\n4. Verify: `git log --oneline main -5`\nThis merges your work back to main so it is not stranded on a dead branch.\nDo NOT use `git fetch . HEAD:main` -- git refuses to move a branch that is checked out elsewhere, and main is always checked out at the repo root.'

export type PromptOptions = {
  autoCommit?: boolean
  /**
   * Does this seat integrate itself? THE SAME FIELD the spawn plan and the
   * `SpawnRequest` carry, so a seat cannot tell the prompt one thing and the
   * exit-time fast-forward another -- see `worktree-mergeback.ts`, which holds
   * both readers side by side.
   *
   * OPT-IN here: absent emits nothing, which is what it always did. An explicit
   * `false` is an epic seat declaring that the werk-master merges it.
   */
  worktreeMergeBack?: boolean
  taskWrapper?: TaskMeta
  /** What to DO with the card. Defaults to `work`. See `task-modes.ts`. */
  mode?: TaskMode
  /** The open-epic roster block (`epic-roster.ts`), when the caller decided
   *  this run can use one. Built by the CALLER because this module is handed a
   *  single card and never the board. Empty/absent emits nothing at all. */
  epicRoster?: string
}

/**
 * Wrap a base prompt with optional task agent host and lifecycle suffixes.
 * Order: taskWrapper(base + suffixes) OR base + suffixes.
 */
export function composeSpawnPrompt(basePrompt: string, opts: PromptOptions = {}): string {
  const suffixes =
    (opts.autoCommit ? AUTO_COMMIT_INSTRUCTIONS : '') +
    (mergeBackInstructionsWanted(opts.worktreeMergeBack) ? WORKTREE_MERGEBACK_INSTRUCTIONS : '')
  if (opts.taskWrapper) {
    return buildTaskPrompt(opts.taskWrapper, suffixes || undefined, basePrompt || undefined, opts.mode, opts.epicRoster)
  }
  return basePrompt + suffixes
}

/**
 * The lifecycle line inside the wrapper. WORK owns the card and moves it;
 * REFINE and ANALYZE are explicitly forbidden from touching status, because a
 * read-only pass that marks five cards in-review is a board that lies.
 */
function modeInstructions(mode: TaskMode | undefined, slug: string): string {
  const spec = taskMode(mode)
  if (spec.flipsStatus) {
    return `Set status to in-progress when you start, in-review when complete. Use mcp__rclaude__project_set_status with id="${slug}".`
  }
  return spec.single
}

/**
 * Build a <project-task> wrapped prompt. Canonical source for both the
 * dashboard task runner and the /workon slash command.
 *
 * If `basePrompt` is provided (non-empty), it overrides the task body content.
 * `mode` selects the lifecycle instruction block; it defaults to `work`, which
 * is byte-for-byte what this emitted before modes existed.
 *
 * `epicRoster` goes BEFORE the instructions, because the soft-link step inside
 * them refers to it ("if an OPEN EPICS list appears in this prompt"). Whether
 * there should be one at all is the caller's call: this function is handed one
 * card and cannot see the board.
 */
export function buildTaskPrompt(
  task: TaskMeta,
  extraInstructions?: string,
  basePrompt?: string,
  mode?: TaskMode,
  epicRoster?: string,
): string {
  const tagAttrs = [
    `id="${task.slug}"`,
    `title="${task.title.replace(/"/g, '&quot;')}"`,
    task.priority && task.priority !== 'medium' ? `priority="${task.priority}"` : '',
    `status="${task.status}"`,
    task.tags.length ? `tags="${task.tags.join(',')}"` : '',
  ]
    .filter(Boolean)
    .join(' ')
  const content = (basePrompt ?? task.body ?? task.bodyPreview ?? task.title).trim() || task.title
  const instructions = modeInstructions(mode, task.slug)
  const roster = epicRoster ? `${epicRoster}\n\n` : ''
  return `<project-task ${tagAttrs}>\n${content}\n\n${roster}${instructions}${extraInstructions || ''}\n</project-task>`
}
