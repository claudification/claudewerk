/**
 * THE PLANNING GENERATION -- generation 0, before anything is dispatched.
 *
 * It is not a fourth role. It is the OVERSEER seat with a different prompt and
 * dispatch suppressed for one beat: same permissions, same board access, same
 * baton, same right to reach a human. A separate role would have duplicated all
 * four for no capability nobody needed.
 *
 * WHY IT EXISTS. Readiness is arithmetic over `depends_on` (`epic-ready.ts`) and
 * nothing else looks at it -- deliberately, because a model asked to eyeball a
 * dependency list will occasionally dispatch against an open one. The cost of
 * that correctness is that the DAG is only as good as the edges somebody
 * remembered to write, and nobody writes the edge between "refactor the parser"
 * and "add a parser flag". Those two dispatch together and collide.
 *
 * So this generation does NOT move the gate to a model. It makes the arithmetic
 * trustworthy by COMPLETING THE GRAPH the arithmetic runs on, once, up front.
 * Every soft constraint it can see becomes a hard `depends_on` edge, and from
 * beat 1 onward the engine enforces it deterministically, for free, forever.
 *
 * It is also the only moment in the run where the board can be fixed cheaply:
 * closing what is already done, filing what everyone forgot, and splitting the
 * card that is secretly four cards all cost one generation here, versus a
 * bounced verdict and a wasted implementer later.
 */

import type { EpicPlan } from './epic-ready'
import type { EpicRun } from './epic-run-store'

export interface PlannerPromptCtx {
  projectUri: string
  projectRoot: string
  run: EpicRun
  plan: EpicPlan
  /** Every card under this epic, as `slug -- title (status)` lines. */
  cardLines: string[]
  /** The epic card's own body, which is where the intent actually lives. */
  epicBody: string
}

const AUTHORITY = [
  'YOU ARE NOT IMPLEMENTING ANYTHING THIS GENERATION. No card is dispatched while you run and none will be',
  'until you exit. You are reading the whole epic once, with fresh eyes, and leaving behind a board the engine',
  'can execute without further judgement.',
].join('\n')

/**
 * The ordering job, stated as the reason it exists. An instruction to "add
 * depends_on where useful" gets a handful of obvious edges; naming the FAILURE
 * -- two agents editing one file at the same time -- gets the edges that matter.
 */
const ORDERING = [
  'THE ORDERING IS THE POINT. After you exit, dispatch is pure arithmetic: every card whose `depends_on` are',
  'all done goes out AT THE SAME TIME, up to the concurrency ceiling. Nothing else is consulted -- not the',
  'titles, not your reasoning, not common sense. Two cards with no edge between them WILL run in parallel, in',
  'separate worktrees, and their branches will be merged independently.',
  '',
  'So the question for every pair of cards is not "is one logically after the other" but "would two agents',
  'doing these simultaneously, without talking, produce a mess". Add `depends_on` when:',
  '  - they edit the same file, or one renames/moves what the other edits;',
  '  - one establishes an interface, a schema, a migration or a config the other consumes;',
  '  - one is a refactor and the other adds to the thing being refactored (this is the classic collision, and',
  '    it almost never has a declared edge);',
  '  - one cannot be verified until the other lands.',
  '',
  'Do NOT add an edge merely to express priority or a preferred order. Every edge you add costs parallelism,',
  'and an over-serialised epic runs one card at a time for no reason. Order that is only a preference belongs',
  'in the card body, not in `depends_on`.',
].join('\n')

function theJob(ctx: PlannerPromptCtx): string {
  const id = ctx.run.epicId
  return [
    'YOUR JOB, IN THIS ORDER:',
    '',
    '1. READ THE INTENT. The epic card body below is what this epic is FOR. Read it, then read every child',
    '   card. You are looking for the gap between what the epic wants and what the cards actually cover.',
    '',
    '2. CLOSE WHAT IS ALREADY DONE. Check the repo, not the board -- a card describing work that is already in',
    '   the tree is the most expensive kind of card, because an implementer will be dispatched to redo it and a',
    '   verifier will be dispatched to judge the redo. Verify against the code, then',
    '   project_set_status(id, status="done") with a one-line note in the body saying where it landed.',
    '   If you are not certain it is done, LEAVE IT. A wrongly-closed card is silently dropped scope.',
    '',
    `3. FILE WHAT IS MISSING. Anything the intent requires and no card covers becomes a new card with`,
    `   \`epic: ${id}\`. Split any card that is secretly several -- a card an implementer cannot finish in one`,
    '   sitting comes back bounced, which costs a full implementer plus a full verifier to learn.',
    '',
    '4. DROP WHAT STOPPED MAKING SENSE. Archive it with the reason in the body. `archived` leaves the',
    '   denominator, so a dropped card does not fake progress.',
    '',
    '5. WRITE THE EDGES. See THE ORDERING above. This is the part nobody does by hand and the part the engine',
    '   cannot infer.',
    '',
    '6. WRITE THE BATON. Append ONE `intent` entry listing EVERY card you created, closed, archived, split or',
    '   re-ordered, and why. Then write the run digest (the body of run.md) as the plan of record. Be complete:',
    '   this entry is the only account Jonas gets of what you changed on his board, and the next generation',
    '   knows nothing except this file and the board.',
  ].join('\n')
}

const STOPPING = [
  'WHEN YOU ARE DONE: stop. Do not dispatch anything, do not implement a card, do not spawn anything -- the',
  'engine takes over the moment you exit and it will not start until then.',
  '',
  'The engine compares the board against the snapshot it took before you started. If you changed it, the run',
  'CHECKPOINTS and Jonas reviews your plan before any work goes out; if the board was already sound, it',
  'proceeds straight to the first beat. Either way that is decided from the board itself, not from your',
  'summary -- so write the baton for the human who has to understand it, not to influence the gate.',
  '',
  'If the epic is fundamentally unclear -- you cannot tell what it is FOR, and guessing would send agents off',
  'to build the wrong thing -- ask Jonas ONE crisp question with your recommendation. You are the only seat in',
  'this run that may. Getting the intent wrong here is the most expensive mistake available to you: every',
  'implementer after this inherits it.',
].join('\n')

export function buildPlannerPrompt(ctx: PlannerPromptCtx): string {
  const r = ctx.plan.rollup
  return [
    `You are THE PLANNER of epic \`${ctx.run.epicId}\` in project ${ctx.projectUri}.`,
    `This is generation 0 -- the analysis pass, before any card is dispatched. Target: ${ctx.run.target}.`,
    `Concurrency ceiling once work starts: ${ctx.run.concurrency}.`,
    '',
    AUTHORITY,
    '',
    `THE EPIC'S OWN CARD (this is the intent -- everything else is an attempt at it):`,
    ctx.epicBody.trim() || '  _empty -- the epic card says nothing about what it is for, which is itself a finding_',
    '',
    r
      ? `THE BOARD: ${r.done}/${r.total} done, ${r.inProgress} in progress, ${r.notStarted} not started, ${r.dropped} dropped.`
      : 'THE BOARD: this epic has no children yet -- your job is to write them.',
    ...(ctx.cardLines.length > 0 ? ['', 'EVERY CARD UNDER THIS EPIC:', ...ctx.cardLines.map(l => `  - ${l}`)] : []),
    '',
    ORDERING,
    '',
    theJob(ctx),
    '',
    `THE BATON: ${ctx.projectRoot}/.rclaude/project/epics/${ctx.run.epicId}/log.md`,
    '',
    STOPPING,
  ].join('\n')
}
