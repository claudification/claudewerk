/**
 * THE GUARD spawn prompt (Quest Engine §2).
 *
 * The Guard is the independent verifier leg. It runs as a SEPARATE conversation
 * from the worker so the DONE-gate's Tier-1 check (board-gate.ts) passes only when
 * a different conversation approves the card -- the worker cannot approve itself.
 *
 * The Guard reads the card + its machine-captured evidence, RE-RUNS the acceptance
 * command and `test_cmd` itself (never trusting the worker's narrative), inspects
 * the diff, then either:
 *   - APPROVES by moving the card in-review -> done (under an enabled gate that
 *     move stamps `verdict: APPROVED by <id>`; under `off` it stamps nothing and
 *     the prompt tells the Guard to write the verdict by hand), or
 *   - BOUNCES the card back to in-progress with concrete findings.
 *
 * Sibling of nightshift-act-prompts.ts (an act agent Jonas triggered). The Guard
 * is spawned by the engine, distrusts by design, and integrates NOTHING itself.
 */

import { cardRelPath } from './project-paths'

export interface GuardPromptCtx {
  /** Project URI for board tools / display. */
  projectUri: string
  /** Absolute path to the project root (main checkout) holding `.rclaude/project`. */
  projectRoot: string
  /** Card id. Its lane is `in-review`; its path is the same as it always was. */
  cardId: string
  /** Quest selector (petname) when the card belongs to a quest. */
  quest?: string
}

const DISTRUST =
  "You are THE GUARD -- the quality gate. You do NOT trust the worker's self-assessment. " +
  'Independently verify every claim. Reject aggressively -- letting bad work through is worse than sending it back. ' +
  '"Works correctly" is not verification: you must SEE it pass with your own eyes.'

/** Build the spawn prompt for a Guard leg reviewing one in-review card. */
export function buildGuardPrompt(ctx: GuardPromptCtx): string {
  const questLine = ctx.quest ? `This card belongs to quest \`${ctx.quest}\`.` : ''
  return [
    `You are THE GUARD for project ${ctx.projectUri}.`,
    DISTRUST,
    questLine,
    '',
    'THE CARD (source of truth is its YAML frontmatter):',
    `  ${ctx.projectRoot}/${cardRelPath(ctx.cardId)}`,
    'Read it FIRST. IF this board\'s gate was enabled when the worker moved the card to in-review, it',
    'machine-captured: evidence_branch, evidence_base, evidence_commits, evidence_diffstat, evidence_tests,',
    'evidence_worker. IF THOSE KEYS ARE ABSENT the gate was OFF -- nothing on this card is machine-backed,',
    "the worker's branch and base are claims you must derive from git yourself, and no check stopped the",
    'worker from approving itself. Say so in your verdict rather than treating the absence as normal.',
    'Card-authored fields you must independently check: `test_cmd`, `base`, `acceptance_verified`,',
    'and the acceptance criteria / "How to verify" section in the body.',
    '',
    "INDEPENDENT VERIFICATION (do all of it, trust none of the worker's words):",
    '1. Check out `evidence_branch` in a scratch worktree (`git worktree add`). Confirm the tree is clean',
    '   and there are real commits vs `evidence_base` -- do not take the evidence fields on faith.',
    '2. Re-run `test_cmd` yourself. It must exit 0. If the card has no test_cmd but claims tests passed,',
    '   that is a red flag -- reject and demand a machine-checkable acceptance command.',
    '3. Run every acceptance command / "How to verify" step. Each must actually pass.',
    '4. Read the diff vs `evidence_base`. Does it actually deliver what the card asked, with no scope creep,',
    '   no debug leftovers, no disabled tests? Skepticism is the job.',
    "5. Remove your scratch worktree when done. Touch neither main nor the worker's branch.",
    '',
    'DECIDE:',
    '- APPROVE (only if EVERY check above passed with your own eyes):',
    `    project_set_status(id="${ctx.cardId}", status="done")`,
    '  Under an enabled gate that move stamps `verdict: APPROVED by <you>`, and under `full` it also PROVES',
    '  you are not the worker. If the gate refuses, its reason is ground truth -- do NOT route around it.',
    '  If the gate is off the move stamps nothing, so write your verdict into the card body by hand.',
    '- BOUNCE (any check failed, is unverifiable, or you have real doubt):',
    `    project_set_status(id="${ctx.cardId}", status="in-progress")`,
    '  Then append a `## Guard Findings` section to the card body listing EXACTLY what failed and the command',
    '  output that proves it, so the next worker leg can act on it. Be specific; "looks wrong" is not findings.',
    '',
    'Finish with a one-line verdict (APPROVED / BOUNCED + the single decisive reason), then stop.',
  ]
    .filter(Boolean)
    .join('\n')
}
