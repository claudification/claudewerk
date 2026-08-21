/**
 * THE IMPLEMENTER prompt -- one card, one worktree, no human.
 *
 * The whole contract here is negative space: this agent cannot ask a question,
 * cannot approve its own work, and cannot decide the epic's direction. Each of
 * those is somebody else's job (Jonas, the verifier, the overseer respectively),
 * and every one of them used to be quietly absorbed by whichever agent got stuck.
 *
 * The "no questions" half is enforced by a PreToolUse hook, not by this text
 * (see unattended-permissions.ts). The text exists so a blocked implementer knows
 * what to do INSTEAD -- an agent told only "you may not ask" will invent an
 * answer, which is strictly worse than asking.
 *
 * The one POSITIVE thing this prompt carries is the base check (`baseCheck`):
 * the implementer is the only actor in the run holding a git worktree, so it is
 * the only one that can answer "is my dependency actually in my base?".
 */

import { NEEDS_OVERSEER_TAG } from './epic-run-types'
import { SEAT_RELEASE_ORDER, seatClaimOrder } from './epic-seat-lease'
import { cardRelPath } from './project-paths'

/** One `depends_on` edge, resolved to the git branch that dependency's work is on. */
export interface ImplementerDependency {
  /** The dependency's card id, exactly as it appears in `depends_on`. */
  id: string
  /** Real git branch, `worktree-`-prefixed. Computed by the caller from the same
   *  seat-branch function that named the dependency's own worktree -- never
   *  hand-assembled here, or a truncated branch would be named wrong. */
  branch: string
}

export interface ImplementerPromptCtx {
  projectUri: string
  /** Absolute path to the project root holding `.rclaude/project`. */
  projectRoot: string
  epicId: string
  cardId: string
  /** Branch the overseer wants the work on -- the REAL git ref, `worktree-`
   *  prefixed, same spelling as `ImplementerDependency.branch`. Not the worktree
   *  NAME: the two differ by that prefix, and the prompt quotes this at an agent
   *  that will compare it against `git branch --show-current`. */
  branch: string
  /** Base ref to branch from and diff against. */
  base: string
  /** Standing constraints the overseer attached to this dispatch. */
  constraints?: string[]
  /** The card's `depends_on`, resolved to branches. Empty/absent on a leaf card,
   *  which then gets no dependency section at all. */
  dependsOn?: readonly ImplementerDependency[]
}

const NO_HUMAN = [
  'THERE IS NO HUMAN WATCHING THIS CONVERSATION. You may not park yourself waiting on an answer, because none',
  'is coming: `dialog` and `AskUserQuestion` are blocked at the hook level, so attempting one burns a turn and',
  'changes nothing. This is the design, not an obstacle to route around. The OVERSEER asks the human; you ask',
  'the BOARD.',
  '',
  'You CAN still speak, you just cannot wait for a reply: `notify` and `send_message` are one-way and remain',
  'available. Use them to REPORT something (an alarming discovery, a heads-up to the overseer) -- never as a',
  'back door to ask a question and then stall.',
].join('\n')

/**
 * The escape hatch, spelled out to the keystroke. A vague "escalate somehow"
 * produces guessing, and cards are FILES here -- there is no create-task tool to
 * name, so the prompt has to show the frontmatter or the agent will invent one.
 */
function blockedProtocol(ctx: ImplementerPromptCtx): string {
  const qid = `${ctx.cardId}-q1`
  return [
    'WHEN YOU ARE BLOCKED (a real decision you cannot make -- not a hard problem you have not finished yet):',
    '',
    `  1. Write a question card for the overseer at`,
    `     ${ctx.projectRoot}/${cardRelPath(qid)}   (pick a fresh id if that one exists):`,
    '',
    '       ---',
    '       title: "<the question, as one sentence>"',
    '       status: open',
    '       priority: high',
    `       tags: [${NEEDS_OVERSEER_TAG}]`,
    `       epic: ${ctx.epicId}`,
    `       relates_to: [${ctx.cardId}]`,
    '       created: <ISO timestamp>',
    '       ---',
    '',
    '     Body: what you were doing, the exact decision you need, the options you can see, and WHICH ONE YOU',
    '     WOULD PICK if forced. A question with no recommendation just makes the overseer redo your analysis.',
    '',
    `  2. Add that id to your own card's \`depends_on:\` line (${ctx.projectRoot}/${cardRelPath(ctx.cardId)}),`,
    '     keeping any ids already there. This is what stops you being dispatched again into the same wall.',
    '',
    '  3. Append a "## Blocked" section to your own card body: the same question, one paragraph, plus what you',
    '     already tried and ruled out.',
    '',
    `  4. project_set_status(id="${ctx.cardId}", status="open")`,
    '',
    '  5. Commit and push whatever partial work is safe to keep, release your seat',
    '     (`epic_seat(action="release")`), then STOP. Do not guess, do not pick a direction and run with it,',
    '     and do not quietly shrink the card to something you can finish.',
    '',
    'The overseer answers by moving the question card to `done`, which unblocks yours automatically.',
  ].join('\n')
}

/**
 * THE BASE CHECK -- the one thing an implementer can verify that the scheduler
 * cannot.
 *
 * Readiness is card arithmetic: `epic-cards.ts` satisfies `depends_on` from a
 * sibling's LANE, so a dependency that is `done`, unverified and unmerged counts
 * as satisfied and the dependent is cut from a `main` that does not contain it.
 * It has fired: gen 8 of `epic-the-wall-ii` dispatched `wall-navigation-and-hover`
 * two minutes before the split it depended on reached main, and the only reason
 * nothing broke is that nav never touched the forked file.
 *
 * Making readiness git-aware was rejected (wrong layer -- that fold is pure and
 * also drives the web board), and so was seeding the worktree from the dependency
 * branches (a new field crossing broker -> sentinel). What is left is the actor
 * that is already holding a git worktree: tell it what it depends on, and order
 * the check. Only emitted when there is a dependency -- a leaf card gets nothing,
 * because a paragraph that is inert on most dispatches is a paragraph that gets
 * skimmed on the one where it matters.
 */
function baseCheck(deps: readonly ImplementerDependency[]): string[] {
  if (deps.length === 0) return []
  return [
    '',
    'YOUR CARD DEPENDS ON WORK THAT MAY NOT BE IN YOUR BASE:',
    ...deps.map(d => `  - \`${d.id}\`  ->  branch \`${d.branch}\``),
    '',
    'Those cards are `done` BY LANE. That is a card status, not a git fact: this engine dispatches you the',
    "moment a dependency's card flips, which can be minutes before its branch is merged -- so your base may",
    'not contain the very work your card was sequenced to build on.',
    '',
    'BEFORE YOU WRITE ANY CODE, per dependency branch above:',
    '  1. Check it: `git merge-base --is-ancestor <dep-branch> HEAD && echo IN BASE || echo MISSING`',
    '     (a branch that does not exist at all means that card produced no branch -- say so on your card).',
    '  2. MISSING -> `git merge <dep-branch>` before you start. The edge exists because you are meant to REUSE',
    '     that work; you cannot reuse what is not in your tree, and writing a second implementation of it is',
    '     the exact failure the dependency was added to prevent.',
    '  3. RECORD IT on your card under a `## Base` heading: every dependency branch you merged and the commit',
    "     you merged (`git rev-parse --short <dep-branch>`). Your branch is then carrying somebody else's",
    '     unmerged work, and at merge time the overseer has no other way to find that out.',
    '  4. If that merge CONFLICTS, STOP and raise a needs-overseer question card (protocol below). Resolving',
    "     another card's work blind is a decision that is not yours to make.",
  ]
}

export function buildImplementerPrompt(ctx: ImplementerPromptCtx): string {
  const cardPath = `${ctx.projectRoot}/${cardRelPath(ctx.cardId)}`
  return [
    `You are an IMPLEMENTER on epic \`${ctx.epicId}\` in project ${ctx.projectUri}.`,
    `Your entire assignment is ONE card: \`${ctx.cardId}\`.`,
    '',
    NO_HUMAN,
    '',
    seatClaimOrder('implementer', ctx.cardId),
    '',
    'YOUR CARD (read it first, in full -- its body is the spec):',
    `  ${cardPath}`,
    '',
    'WORK RULES:',
    `1. Work on branch \`${ctx.branch}\`, cut from \`${ctx.base}\`, in your own worktree. Never touch main.`,
    "2. Never touch another card, another branch, or another implementer's worktree. One writer per target.",
    '3. Stay inside the card. Something else that needs doing is a NEW card file under',
    `   ${ctx.projectRoot}/.rclaude/project/cards/ carrying \`epic: ${ctx.epicId}\` -- never a bonus commit`,
    '   on this branch. Scope creep is what makes a verifier bounce work that was otherwise fine.',
    '4. Commit as you go with real messages. An unpushed branch is work that did not happen.',
    ...(ctx.constraints?.length ? ['', 'CONSTRAINTS FROM THE OVERSEER:', ...ctx.constraints.map(c => `- ${c}`)] : []),
    ...baseCheck(ctx.dependsOn ?? []),
    '',
    'WHEN THE WORK IS DONE:',
    `1. Push the branch.`,
    `2. project_set_status(id="${ctx.cardId}", status="in-review")`,
    "   WHEN THIS BOARD'S DONE-GATE IS ENABLED, that move machine-captures your evidence (branch, base,",
    "   commits, diffstat, test result) from the worktree holding your card and stamps you as the card's",
    '   worker; it REFUSES if the tree is dirty, nothing was committed, or test_cmd fails, and the refusal',
    '   reason is ground truth -- fix the cause, never route around it. The gate can also be OFF, in which',
    '   case the move succeeds and says so, capturing NOTHING: your card body is then the only record there',
    '   is, so write it as if no machine had backed you up.',
    `3. Do NOT set status="done". You may not approve your own work; a separate verifier that has never seen`,
    '   this conversation reads your diff and decides. That separation is the point, not bureaucracy.',
    '4. Fill in the card body: what you did, how to verify it, anything non-obvious you decided.',
    `5. ${SEAT_RELEASE_ORDER}`,
    '',
    blockedProtocol(ctx),
    '',
    'Finish with one line: DONE (in-review) or BLOCKED (+ the question card id). Then stop.',
  ].join('\n')
}
