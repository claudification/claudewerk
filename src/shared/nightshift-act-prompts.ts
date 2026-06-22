/**
 * NIGHTSHIFT ACT-ON-RESULTS prompt templates (plan §4).
 *
 * Each ACT button on the Result screen spawns an ORDINARY fleet agent pointed at
 * the project's `.nightshift/latest` artifact folder. The artifact frontmatter is
 * the contract; the agent greps it and acts. These templates are the agent's
 * instructions. Unlike the unattended night-run workers (nightshift-preamble.ts),
 * an act agent was triggered BY Jonas from the morning report -- so it IS
 * authorized to integrate to main on his behalf.
 *
 * Outcomes are written BACK with `nightshift(action=patch, ...)` so the Result
 * screen reflects them without clobbering the night worker's original fields.
 */

export interface ActPromptCtx {
  projectUri: string
  /** Absolute path to the project root (the main checkout). */
  projectRoot: string
  /** The run being acted on, YYYY-MM-DD. */
  runId: string
  /** Optional task-id filter (per-card acts, targeted bundle/discard). */
  taskIds?: string[]
  /** Freeform instruction (kind=freeform) or discard reason. */
  freeform?: string
}

/** The shared header every act prompt opens with: the contract + report path. */
function header(ctx: ActPromptCtx): string {
  return [
    `You are a NIGHTSHIFT ACT-ON-RESULTS agent for project ${ctx.projectUri}.`,
    'Jonas triggered you from the morning Result screen, so you ARE authorized to act on his',
    'behalf -- unlike the unattended night-run workers, you may integrate to main when asked.',
    '',
    `THE CONTRACT is the artifact folder: ${ctx.projectRoot}/.nightshift/latest`,
    '  run.md            run-level frontmatter + digest',
    '  tasks/NNN-*.md    one file per task; the YAML frontmatter is the source of truth',
    '  blocked/  skipped.md',
    'Read every tasks/*.md frontmatter FIRST. Fields that matter: id, title, branch, base,',
    'verdict, tests, status, diffstat, acceptance, files.',
    '',
    'WRITE OUTCOMES BACK so the Result screen updates (patches frontmatter in place, no clobber):',
    `  nightshift(action=patch, project=${ctx.projectUri}, run_id=${ctx.runId}, id=<NNN>,`,
    '            status=..., tests=..., verdict=..., note="<one-line audit note>")',
    '',
    'COVENANT (this repo, read .claude/CLAUDE.md): integrate via `git merge --ff-only` into LOCAL',
    'main then `git push origin main`. NEVER a merge commit, NEVER force-push, NEVER push a branch',
    'to main. Keep everything reviewable. If git status shows another agent’s in-flight work,',
    'coordinate via list_conversations/send_message first -- never checkout/stash/reset their files.',
  ].join('\n')
}

function filterLine(ctx: ActPromptCtx): string {
  return ctx.taskIds?.length ? `Act ONLY on these task ids: ${ctx.taskIds.join(', ')}.` : ''
}

function integratePrompt(ctx: ActPromptCtx): string {
  return [
    header(ctx),
    '',
    'TASK: Integrate every ready-to-review task whose tests pass.',
    filterLine(ctx),
    'For each tasks/*.md with `verdict: ready-to-review` AND `tests: pass`, in id order:',
    '1. Re-run its acceptance check (the `acceptance` field / "How to verify" section). If it now',
    '   FAILS, do NOT integrate -- patch tests=fail with a note and leave it for Jonas.',
    '2. Fast-forward-only merge its `branch` onto LOCAL main (rebase the branch on main first if it',
    '   will not FF). NEVER a merge commit.',
    '3. `git push origin main`.',
    '4. Patch the task: status=integrated, note="integrated <branch> ff-only @<short-sha>".',
    '5. Remove the worktree + delete the branch ONLY if fully merged (`git log main..branch` empty).',
    'If a branch will not FF and rebasing hits conflicts you cannot resolve mechanically, STOP on',
    'that task, patch a note, and carry on with the rest. Finish with a one-line integrated-vs-skipped',
    'summary, then stop.',
  ]
    .filter(Boolean)
    .join('\n')
}

function testPrompt(ctx: ActPromptCtx): string {
  return [
    header(ctx),
    '',
    'TASK: Run each task’s acceptance and record the result. Do NOT integrate anything.',
    filterLine(ctx),
    'For each tasks/*.md that has a `branch` and an acceptance/"How to verify" command:',
    '1. Check the branch out in a scratch worktree (`git worktree add`), run the acceptance command.',
    '2. Patch the task: tests=pass|fail, note="acceptance: <cmd> -> <pass|fail>".',
    '3. Remove the scratch worktree.',
    'Leave LOCAL main and the task branches untouched. Finish with a pass/fail tally, then stop.',
  ]
    .filter(Boolean)
    .join('\n')
}

function bundlePrompt(ctx: ActPromptCtx): string {
  return [
    header(ctx),
    '',
    'TASK: Combine related ready-to-review tasks into ONE review branch (do NOT touch main).',
    filterLine(ctx) || 'Default selection: all ready-to-review tasks with tests:pass.',
    `1. Create a fresh branch off LOCAL main: nightshift-bundle/${ctx.runId}.`,
    '2. Merge each chosen task branch into it (ff-only or rebase-then-merge; avoid merge commits).',
    '   Resolve trivial conflicts; STOP + note on a hard conflict.',
    `3. Push the bundle branch to origin (\`git push -u origin nightshift-bundle/${ctx.runId}\`) so`,
    '   Jonas can review it. Do NOT push to main.',
    `4. Patch each bundled task: note="bundled into nightshift-bundle/${ctx.runId}" (leave verdict).`,
    'Finish by reporting the bundle branch name + the tasks it carries, then stop.',
  ]
    .filter(Boolean)
    .join('\n')
}

function discardPrompt(ctx: ActPromptCtx): string {
  const reason = ctx.freeform?.trim()
  return [
    header(ctx),
    '',
    'TASK: Reject the named task(s) and record why -- this feeds the future Advisor. Do NOT touch main.',
    ctx.taskIds?.length
      ? `Discard these task ids: ${ctx.taskIds.join(', ')}.`
      : 'No task id was given. A discard needs a target -- report that you need an id from Jonas and stop.',
    reason
      ? `Reason from Jonas: ${reason}`
      : 'If no reason is obvious, ask Jonas (report blocked) rather than guessing.',
    'For each target task:',
    '1. Patch the task: status=discarded, verdict=declined, note="discarded: <reason>".',
    '2. Record it in the skipped lane so the reason survives for the Advisor:',
    `   nightshift(action=report, kind=skipped, project=${ctx.projectUri}, run_id=${ctx.runId}, id=<NNN>,`,
    '             title=<title>, feasibility=uncertain, reason="<reason>").',
    '3. Delete the task’s nightshift branch/worktree ONLY if it is the nightshift branch and unmerged',
    '   (the rejected work) -- never a shared branch. Finish with what was discarded, then stop.',
  ]
    .filter(Boolean)
    .join('\n')
}

function freeformPrompt(ctx: ActPromptCtx): string {
  return [
    header(ctx),
    '',
    'TASK (freeform, from Jonas):',
    ctx.freeform?.trim() || '(no instruction given -- report that you need one and stop)',
    '',
    'Interpret it against the artifact folder above. Patch task outcomes back as you go. Follow the',
    'covenant for any integration. Finish with a one-line summary of what you did, then stop.',
  ].join('\n')
}

const BUILDERS = {
  integrate: integratePrompt,
  test: testPrompt,
  bundle: bundlePrompt,
  discard: discardPrompt,
  freeform: freeformPrompt,
} as const

export type NightshiftActKind = keyof typeof BUILDERS

export function buildActPrompt(kind: NightshiftActKind, ctx: ActPromptCtx): string {
  return BUILDERS[kind](ctx)
}
