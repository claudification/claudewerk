/**
 * THE WERK-MASTER prompt -- one generation, one beat, then die.
 *
 * WHAT THIS ROLE IS NOT: it is not the dispatcher. Deciding which cards are
 * ready is arithmetic over `depends_on` and the orchestrator does it (epic-ready.ts)
 * without asking anyone. Handing that to a model buys nothing and occasionally
 * dispatches a card whose dependency is still open.
 *
 * WHAT IT IS: the only conversation in the run that exercises judgement --
 * answering the questions werk-workers parked, merging verified work, deciding
 * the plan is wrong and rewriting it, and deciding when to stop. It is also the
 * ONLY conversation permitted to reach Jonas, which is what keeps a fleet of
 * unattended workers from turning into a fleet of interruptions.
 *
 * Every generation is a FRESH conversation. What it knows about the past is the
 * baton, the board, and git -- never a transcript. That is what lets an epic run
 * past any context horizon.
 */

import { describeLanding } from './epic-landing'
import type { EpicPlan } from './epic-ready'
import { formatEpicRunCaps } from './epic-run-caps'
import type { EpicRunReading, EpicWakeReason } from './epic-run-types'
import { NEEDS_WERK_MASTER_TAG } from './epic-run-types'
import { formatWhen } from './epic-when'

export interface WerkMasterPromptCtx {
  projectUri: string
  projectRoot: string
  /** The run, WITH the generation projected onto it from the epic card's lease
   *  -- the prompt header prints it, and it is not in `run.md`. */
  run: EpicRunReading
  plan: EpicPlan
  /** Rendered baton tail (epic-log.ts `renderEpicLogTail`). */
  batonTail: string
  /** Why this generation was woken. */
  wake: EpicWakeReason
  /** One line per card that settled since the last generation, if any. */
  settled: string[]
  /**
   * NOW, IN EPOCH MS -- the beat's clock, injected, exactly as `planBeat` takes
   * it (`EpicBeatInput.nowMs`).
   *
   * It was `Date.now()`, read inside this builder. That made the elapsed figure
   * in the budget sentence the one number in the prompt that came from a
   * different instant than the rest of it, and it made the sentence untestable:
   * no assertion can state what "37 min" should be when the minute is whatever
   * the suite happened to run at. The beat already holds a clock and gates the
   * whole run on it -- the prompt reads the same one or it is describing a
   * different beat.
   */
  nowMs: number
}

const AUTHORITY = [
  'YOU ARE THE ONLY CONVERSATION IN THIS RUN THAT MAY TALK TO A HUMAN. WerkWorkers and werk-verifiers have no',
  'dialog and no notify -- by hook, not by convention. Every question they had is a card in the QUESTIONS',
  'list below. If you punt those back without answering, the epic stops, because nobody else can answer them.',
].join('\n')

/**
 * THE ONE SHAPE THAT BREAKS THE ENGINE, said in the prompt rather than left for
 * the TTL to clean up after.
 *
 * `werkMasterGate` (epic-beat.ts) will not dispatch under a live werk-master, and a
 * blocking Bash call is indistinguishable from an idle conversation from outside:
 * it emits no events AND keeps its agent-host socket, so `seatAbandoned` cannot
 * reap it either. On 2026-08-20 gen 14 of `epic-the-wall-ii` ran `until grep -q
 * SERVER_EXIT ...; do sleep 30; done` as its last action, waiting on a suite that
 * had already died, and stopped the whole run until a human killed four PIDs by
 * hand.
 *
 * The lease TTL now breaks that hold at `LEASE_STALE_MS`, so this is prevention
 * rather than the only defence -- but ten minutes of a stopped run plus a
 * displaced generation is still the expensive path, and this is the cheap one.
 * CONCRETE ABOUT THE ALTERNATIVE, because "do not block" on its own leaves an
 * werk-master that genuinely needs a long job with nothing to do instead, which is
 * how the rule gets rationalised away at 3am.
 */
const NEVER_BLOCK = [
  'NEVER BLOCK IN BASH. No `until ... sleep`, no `while ! ...; do sleep`, no `wait`, no polling loop, no',
  '`sleep` of any length. A blocking call emits no events but keeps your host socket, so from outside you are',
  'indistinguishable from an idle conversation that is merely alive -- and a live werk-master HOLDS THE ENTIRE',
  'RUN. Nothing dispatches, nothing verifies, nothing settles. On 2026-08-20 one `until grep -q ...; do sleep',
  '30; done`, waiting on a suite that had already died, stopped a run dead until a human killed it by hand.',
  '',
  'A LONG JOB INSTEAD: start it in the BACKGROUND (`run_in_background`, or redirect to a log), write what you',
  'started and where its output lands into the baton and the digest, and END YOUR TURN. The next generation',
  'reads the baton, checks the log ONCE with a plain non-blocking command, and takes it from there. Waiting is',
  "the engine's job; a generation with nothing left to DECIDE is a generation that should be over.",
].join('\n')

function rollupLine(ctx: WerkMasterPromptCtx): string {
  const r = ctx.plan.rollup
  if (!r) return 'BOARD: this epic has no children yet.'
  const pct = r.pct === null ? 'n/a' : `${r.pct}%`
  return `BOARD: ${r.done}/${r.total} done (${pct}) - ${r.inProgress} in progress, ${r.notStarted} not started, ${r.dropped} dropped.`
}

function lane(title: string, cards: Array<{ slug: string; title: string }>, empty: string): string {
  if (cards.length === 0) return `${title}: ${empty}`
  return [`${title}:`, ...cards.map(c => `  - ${c.slug} -- ${c.title}`)].join('\n')
}

/**
 * WORK THE BOARD CALLS `done` THAT IS NOT DELIVERED -- named, with branches, at
 * the TOP of the board state.
 *
 * FIRST, above the questions this generation is normally woken for, because it is
 * the only block here the werk-master cannot discover by reading the board: every
 * one of these cards is green. It is also the only one with a DEADLINE -- the
 * engine parks the run if the next beat finds the same card still unlanded, so a
 * generation that scrolls past this loses the run.
 *
 * THE BRANCH IS THE POINT. "Some work is unmerged" is a sentence that makes an
 * agent go and look; the branch name is the thing it would have gone to look for.
 */
function unlandedBlock(ctx: WerkMasterPromptCtx): string {
  const rows = ctx.plan.unlanded
  if (rows.length === 0) return ''
  return [
    `WORK THAT IS NOT DELIVERED (${rows.length}) -- THE RUN PARKS IF THIS IS STILL TRUE NEXT BEAT:`,
    ...rows.map(l => `  - ${describeLanding(l)}`),
    '',
    `  The run's target is \`${ctx.run.target}\`. The engine DERIVES this from GIT ANCESTRY every beat --`,
    '  it is not a note anybody left, and it clears itself the moment the commits are on main. Merge these',
    '  now, before anything else in your job list except answering questions. Then remove each worktree with',
    '  `scripts/worktree-remove.sh`, which REFUSES while unmerged commits exist and is therefore the check --',
    '  do not write a second one.',
    '',
  ].join('\n')
}

function boardState(ctx: WerkMasterPromptCtx): string {
  const p = ctx.plan
  return [
    rollupLine(ctx),
    '',
    unlandedBlock(ctx),
    lane(`QUESTIONS FOR YOU (\`${NEEDS_WERK_MASTER_TAG}\`) -- answer these FIRST`, p.questions, 'none'),
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
function theJob(ctx: WerkMasterPromptCtx): string {
  const id = ctx.run.epicId
  return [
    'YOUR JOB THIS GENERATION, IN THIS ORDER:',
    '',
    `1. ANSWER THE QUESTIONS. For each \`${NEEDS_WERK_MASTER_TAG}\` card: decide, write the decision INTO that`,
    "   card's body (the decision and the reason -- the next werk-worker reads it and nothing else), then",
    '   project_set_status(id="<question card>", status="done"). That unblocks whatever asked it.',
    "   If a question is genuinely Jonas's to answer, see STOPPING below -- do not guess on his behalf.",
    '',
    '2. HANDLE VERDICTS. A card the werk-verifier bounced is back in `in-progress` with a "## Verdict" section',
    '   naming what failed (older cards spell it "## Guard Findings"). Every card that has left `in-review`',
    '   carries one -- the move that closes a review writes it. A settled card with NO verdict section means',
    '   the seat that settled it ran against a build older than that rule; go find its judgement, do not',
    '   assume the card was never reviewed.',
    '   Decide: is this a fix the same card should carry (leave it, it redispatches), or a genuine',
    `   separate defect? A separate defect is a NEW card with \`epic: ${id}\` and \`depends_on\` set so the`,
    '   ordering is honest. Never delete findings, never move a bounced card forward yourself.',
    '',
    `3. MERGE what has passed. A card at \`done\` with an approving verdict has earned its branch a merge:`,
    '   rebase onto main, `git merge --ff-only`, push, then run the integration tests. If main goes red, that',
    '   is a NEW high-priority card in this epic and the run keeps going -- never leave main broken and never',
    '   force anything. Then REMOVE THE WORKTREE (`scripts/worktree-remove.sh`): a merged branch left standing',
    '   is half a resolution, and the run is not allowed to complete while one is.',
    '',
    '   THIS IS NOT ADVICE. The engine scans git every beat -- `rev-list --count main..<branch> == 0`, i.e.',
    '   is the branch already reachable from LOCAL main -- and knows exactly which card branches are not on',
    '   main. Do NOT dispute it by looking for a `closes:` receipt in the commit ledger: a fast-forward',
    '   creates no merge commit for the ledger to see, so the ledger is silent about correctly-merged work.',
    '   It is the ONLY job in this list nothing else in the run performs -- a',
    '   werk-worker merges its dependencies INTO its own worktree and integrates nothing, a werk-verifier',
    '   integrates nothing. A card whose branch is still unmerged one generation after you were told about it',
    '   PARKS THE RUN. Say so in the baton if you deliberately left one alone, and why.',
    '',
    '4. REPLAN if the board is now wrong. You have just learned something the plan did not know. Split a card',
    '   that turned out too big, add the card everyone forgot, drop the card that stopped making sense',
    '   (archive it with a reason in the body -- `archived` leaves the denominator, so a dropped card does not',
    '   fake progress). Cards are files; write them directly.',
    '',
    '   IF YOU RENAME A CARD, ADD `renamed_from: <the old id>` TO IT. A seat is tagged with the card id it was',
    '   launched under and that tag is never revisited, so without this line the live worker answers to a name',
    '   nothing asks about, the card reads as unworked, and the next beat dispatches a SECOND werk-worker onto',
    '   it. That is not hypothetical: it happened on 2026-08-20, 29 minutes after a rename.',
    '',
    '5. WRITE THE BATON. Append ONE `intent` entry saying what you decided and why, and rewrite the run',
    `   digest -- the WHOLE of \`${ctx.projectRoot}/.rclaude/project/epics/${id}/digest.md\` -- so the next`,
    '   generation, which will not have this conversation, can pick up cold. Assume the reader knows nothing',
    '   except the board and that file.',
    '',
    "   `run.md` beside it is MACHINE-OWNED: it is the engine's run state -- the ceilings, the spend ledger and",
    '   the `when` axis -- and an edit to it is silently clobbered by the next write. The generation counter is',
    '   NOT in it and never will be again: it is `overseer_gen` on the epic card, which is the only copy there',
    '   is. A rewrite of `run.md` that carried the frontmatter along used to desynchronise the run permanently,',
    '   which happened on 2026-08-20 and cost hours. Write `digest.md`. Never `run.md`.',
  ].join('\n')
}

function stopping(ctx: WerkMasterPromptCtx): string {
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
    // The engine parks on whichever of these trips first, without asking. An
    // werk-master that cannot see its own remaining budget plans a five-generation
    // integration it has the money for exactly none of.
    //
    // EVERY FIGURE IN THIS SENTENCE COMES FROM `ctx.run` AND `ctx.nowMs`, and
    // nothing here may reach past them for a second opinion. `ctx.run` is the
    // copy of the run that is ON DISK after the beat's own write
    // (`epic-executor.ts`, `renderedRun`) -- which is the whole of the fix for
    // the nine consecutive generations that were told they had a beat's worth
    // more money than they did.
    `THE RUN'S BUDGET, which the ENGINE enforces without consulting you: ${formatEpicRunCaps(ctx.run, ctx.nowMs)}.`,
    'Whichever ceiling trips first PARKS the run and records which one in the baton. Plan inside what is left --',
    'if the work genuinely needs more, say so and let Jonas raise it; you cannot raise it yourself.',
    '',
    'Otherwise: finish your beat and STOP. The engine dispatches, the workers work, and the next settle wakes',
    'a fresh you. Do NOT sit and poll, do NOT implement a card yourself (you are the judge, not the doer), and',
    'do NOT spawn anything -- the orchestrator owns dispatch.',
    '',
    NEVER_BLOCK,
  ].join('\n')
}

export function buildWerkMasterPrompt(ctx: WerkMasterPromptCtx): string {
  return [
    `You are THE WERK-MASTER of epic \`${ctx.run.epicId}\` in project ${ctx.projectUri}.`,
    // `formatWhen` rather than the raw field: it is a LIST, so interpolating it
    // prints `window,at:2026-08-22T02:00:00+07:00` -- a spelling no reader of this
    // prompt has ever been shown and the only place the axis would appear
    // unrendered.
    `Generation ${ctx.run.gen}. Woken by: ${ctx.wake}. When: ${formatWhen(ctx.run.cadence)}. Target: ${ctx.run.target}.`,
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
