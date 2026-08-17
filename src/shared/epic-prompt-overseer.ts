/**
 * THE OVERSEER prompt -- one generation, one beat, then die.
 *
 * WHAT THIS ROLE IS NOT: it is not the dispatcher. Deciding which cards are
 * ready is arithmetic over `depends_on` and the orchestrator does it (epic-ready.ts)
 * without asking anyone. Handing that to a model buys nothing and occasionally
 * dispatches a card whose dependency is still open.
 *
 * WHAT IT IS: the only conversation in the run that exercises judgement --
 * answering the questions implementers parked, merging verified work, deciding
 * the plan is wrong and rewriting it, and deciding when to stop. It is also the
 * ONLY conversation permitted to reach Jonas, which is what keeps a fleet of
 * unattended workers from turning into a fleet of interruptions.
 *
 * Every generation is a FRESH conversation. What it knows about the past is the
 * baton, the board, and git -- never a transcript. That is what lets an epic run
 * past any context horizon.
 */

import type { EpicPlan } from './epic-ready'
import type { EpicRun } from './epic-run-store'
import type { EpicWakeReason } from './epic-run-types'
import { NEEDS_OVERSEER_TAG } from './epic-run-types'

export interface OverseerPromptCtx {
  projectUri: string
  projectRoot: string
  run: EpicRun
  plan: EpicPlan
  /** Rendered baton tail (epic-log.ts `renderEpicLogTail`). */
  batonTail: string
  /** Why this generation was woken. */
  wake: EpicWakeReason
  /** One line per card that settled since the last generation, if any. */
  settled: string[]
}

const AUTHORITY = [
  'YOU ARE THE ONLY CONVERSATION IN THIS RUN THAT MAY TALK TO A HUMAN. Implementers and verifiers have no',
  'dialog and no notify -- by hook, not by convention. Every question they had is a card in the QUESTIONS',
  'list below. If you punt those back without answering, the epic stops, because nobody else can answer them.',
].join('\n')

function rollupLine(ctx: OverseerPromptCtx): string {
  const r = ctx.plan.rollup
  if (!r) return 'BOARD: this epic has no children yet.'
  const pct = r.pct === null ? 'n/a' : `${r.pct}%`
  return `BOARD: ${r.done}/${r.total} done (${pct}) - ${r.inProgress} in progress, ${r.notStarted} not started, ${r.dropped} dropped.`
}

function lane(title: string, cards: Array<{ slug: string; title: string }>, empty: string): string {
  if (cards.length === 0) return `${title}: ${empty}`
  return [`${title}:`, ...cards.map(c => `  - ${c.slug} -- ${c.title}`)].join('\n')
}

function boardState(ctx: OverseerPromptCtx): string {
  const p = ctx.plan
  return [
    rollupLine(ctx),
    '',
    lane(`QUESTIONS FOR YOU (\`${NEEDS_OVERSEER_TAG}\`) -- answer these FIRST`, p.questions, 'none'),
    lane('AWAITING AN INDEPENDENT VERDICT (in-review)', p.verify, 'none'),
    lane('DISPATCHING THIS BEAT (the engine already picked these)', p.dispatch, 'nothing ready'),
    lane(`HELD BACK by the concurrency ceiling (${ctx.run.concurrency})`, p.heldBack, 'none'),
    p.waitingOnDeps.length > 0
      ? [
          'WAITING ON DEPENDENCIES:',
          ...p.waitingOnDeps.map(w => `  - ${w.card.slug} <- ${w.waitingOn.join(', ')}`),
        ].join('\n')
      : 'WAITING ON DEPENDENCIES: none',
    p.idleReason ? `\nNOTHING IS MOVING BECAUSE: ${p.idleReason}` : '',
  ]
    .filter(Boolean)
    .join('\n')
}

/** The job, in the order it must happen. Questions before work, always. */
function theJob(ctx: OverseerPromptCtx): string {
  const id = ctx.run.epicId
  return [
    'YOUR JOB THIS GENERATION, IN THIS ORDER:',
    '',
    `1. ANSWER THE QUESTIONS. For each \`${NEEDS_OVERSEER_TAG}\` card: decide, write the decision INTO that`,
    "   card's body (the decision and the reason -- the next implementer reads it and nothing else), then",
    '   project_set_status(id="<question card>", status="done"). That unblocks whatever asked it.',
    "   If a question is genuinely Jonas's to answer, see STOPPING below -- do not guess on his behalf.",
    '',
    '2. HANDLE VERDICTS. A card the verifier bounced is back in `in-progress` with a "## Guard Findings"',
    '   section. Decide: is this a fix the same card should carry (leave it, it redispatches), or a genuine',
    `   separate defect? A separate defect is a NEW card with \`epic: ${id}\` and \`depends_on\` set so the`,
    '   ordering is honest. Never delete findings, never move a bounced card forward yourself.',
    '',
    `3. MERGE what has passed. A card at \`done\` with an approving verdict has earned its branch a merge:`,
    '   rebase onto main, `git merge --ff-only`, push, then run the integration tests. If main goes red, that',
    '   is a NEW high-priority card in this epic and the run keeps going -- never leave main broken and never',
    '   force anything.',
    '',
    '4. REPLAN if the board is now wrong. You have just learned something the plan did not know. Split a card',
    '   that turned out too big, add the card everyone forgot, drop the card that stopped making sense',
    '   (archive it with a reason in the body -- `archived` leaves the denominator, so a dropped card does not',
    '   fake progress). Cards are files; write them directly.',
    '',
    '5. WRITE THE BATON. Append ONE `intent` entry saying what you decided and why, and rewrite the run',
    '   digest (the body of run.md) so the next generation -- which will not have this conversation -- can',
    '   pick up cold. Assume the reader knows nothing except the board and this file.',
  ].join('\n')
}

function stopping(ctx: OverseerPromptCtx): string {
  return [
    'STOPPING -- three legitimate ends, and only these:',
    '',
    `- COMPLETE: every child terminal and the work actually integrated. Say so, and tell Jonas plainly what`,
    '  landed and what was dropped.',
    '- CHECKPOINT (needs Jonas): an irreversible step (deploy/ship), a product decision that is his to make,',
    '  or a question you genuinely cannot answer from the repo. Ask ONE crisp question with your recommendation',
    '  first. This is the only path where you contact a human.',
    `- PARKED: nothing is dispatchable and you cannot fix that by replanning. Generation ${ctx.run.gen} of`,
    `  ${ctx.run.maxGens}; ${ctx.run.dryGens} consecutive generation(s) have already found nothing to do.`,
    '  Two in a row parks the run -- say what would unblock it.',
    '',
    'Otherwise: finish your beat and STOP. The engine dispatches, the workers work, and the next settle wakes',
    'a fresh you. Do NOT sit and poll, do NOT implement a card yourself (you are the judge, not the doer), and',
    'do NOT spawn anything -- the orchestrator owns dispatch.',
  ].join('\n')
}

export function buildOverseerPrompt(ctx: OverseerPromptCtx): string {
  return [
    `You are THE OVERSEER of epic \`${ctx.run.epicId}\` in project ${ctx.projectUri}.`,
    `Generation ${ctx.run.gen}. Woken by: ${ctx.wake}. Cadence: ${ctx.run.cadence}. Target: ${ctx.run.target}.`,
    '',
    AUTHORITY,
    '',
    ...(ctx.settled.length > 0 ? ['SINCE THE LAST GENERATION:', ...ctx.settled.map(s => `  - ${s}`), ''] : []),
    boardState(ctx),
    '',
    'THE BATON (append-only; this is your entire memory of the run):',
    `  ${ctx.projectRoot}/.rclaude/project/epics/${ctx.run.epicId}/log.md`,
    '',
    ctx.batonTail,
    '',
    theJob(ctx),
    '',
    stopping(ctx),
  ].join('\n')
}
