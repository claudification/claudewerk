/**
 * THE EPIC SWEEP, EXPRESSED AS A SCANNER.
 *
 * This is the pass that used to be the body of `sweepEpics`: find every epic
 * worth a beat, beat each one, never let one epic's failure stop the others. The
 * only thing that changed is that it now ACCOUNTS for what it did -- every epic it
 * selected comes back either acted-on or refused into a named bucket, which is
 * what `runScan` checks.
 *
 * The cadence, the reentrancy guard and the restart quarantine stayed behind in
 * `epic-sweep-loop.ts` on purpose. A scanner is invoked; it does not schedule
 * itself, and `beatOneEpic` deliberately shares the loop's guard while running
 * DIFFERENT work (one epic, not all of them).
 *
 * WHY THE UNIT IS AN EPIC AND NOT A CARD. At this level the sweep's decision is
 * per epic -- beat it or do not. The per-CARD refusals (`waitingOnDeps`,
 * `heldBack`, `questions`, `unspawnable`) are computed one layer down, by
 * `planEpic`, and surface here inside the beat's own note, which is exactly where
 * `idleReason` already puts them. Hoisting them would mean reshaping the executor,
 * and this card is a no-behaviour-change extraction.
 */

import type { EpicRunView } from '../epic-broker-rpc'
import { type BeatContext, runEpicBeat } from '../epic-executor'
import { epicIo } from '../epic-io'
import { planProjectQueues, toQueueScope } from '../epic-queue'
import { type EpicGroup, epicsToWatch } from '../epic-sweep'
import type { SweepDeps } from '../epic-sweep-loop'
import type { Refusal, Scanner, ScanOutcome } from './scanner'

/**
 * Every way the epic sweep can decline to move an epic. Two, and they are
 * genuinely different: a beat that RAN and found nothing to do is a healthy idle
 * run, while a beat that THREW is a broken sentinel or a broken epic and wants a
 * human. Folding them together is how a dead project looks like a quiet one.
 */
export type EpicRefusalBucket = 'idle' | 'beat-crashed'

const EPIC_REFUSAL_BUCKETS: readonly EpicRefusalBucket[] = ['idle', 'beat-crashed'] as const

/** Every epic worth a beat this tick. The SAME set the activity feed reports --
 *  see `epicsToWatch`, which is shared precisely so the two cannot drift. */
export function epicsToBeat(deps: SweepDeps): EpicGroup[] {
  return epicsToWatch(deps.getAllConversations(), deps.isLive, deps.producedOutput, deps.seatReaper, deps.overseerReaper)
}

/** `${project}\0${epicId}`, so two projects may carry an epic of the same name. */
const runKey = (group: EpicGroup): string => `${group.project}\0${group.epicId}`

/**
 * READ EVERY RUN BEFORE BEATING ANY OF THEM -- the pre-pass the queue gate needs.
 *
 * "Is anything else running?" is a question about the PROJECT, so it cannot be
 * answered inside one epic's beat: by the time epic B beats, epic A has already
 * acted on an answer nobody had computed. So the runs are read up front, the
 * whole project's queue is decided once, and each beat is handed BOTH its own run
 * and its verdict.
 *
 * IT COSTS NOTHING EXTRA. The beat used to fetch its own run as its first act;
 * now the scanner fetches it and passes it down, so the round-trip count per tick
 * is exactly what it was -- one `get` per epic. A version of this that read the
 * runs and let the beat read them again would have doubled the sentinel traffic
 * of every tick, over a 1 MB baton file for the oldest epics.
 *
 * A FETCH THAT THROWS IS THE BEAT CRASHING, one step earlier, and it is recorded
 * as exactly that -- not retried and not swallowed. The read used to be the
 * beat's own first act, so a sentinel that exploded produced one `beat-crashed`
 * refusal naming the error; moving the read up here must not turn that into a
 * silent second attempt, nor into a bucket with nothing in it.
 *
 * The try/catch wraps the CALL rather than the promise, because a broken RPC can
 * throw synchronously and a `.catch()` on a call that never returned a promise
 * catches nothing.
 */
async function prefetchRuns(
  deps: SweepDeps,
  groups: readonly EpicGroup[],
): Promise<{ views: Map<string, EpicRunView>; failures: Map<string, string> }> {
  const views = new Map<string, EpicRunView>()
  const failures = new Map<string, string>()
  await Promise.all(
    groups.map(async group => {
      try {
        views.set(runKey(group), await epicIo().fetchEpicRun(deps, group.project, group.epicId))
      } catch (err) {
        failures.set(runKey(group), err instanceof Error ? err.message : String(err))
      }
    }),
  )
  return { views, failures }
}

/**
 * EVERYTHING A BEAT SHOULD BE TOLD RATHER THAN ASK -- built once for a set of
 * epics, consumed one epic at a time.
 *
 * Exported because `beatOneEpic` needs the identical treatment: a forced beat
 * runs the same plan the sweep would, so it has to see the same queue, or BEAT
 * NOW becomes a back door around the one gate whose entire promise is that
 * nothing else dispatches. Hand it the epic's PROJECT PEERS, never one group --
 * a queue of one is always free.
 */
export async function planBeatContexts(deps: SweepDeps, groups: readonly EpicGroup[]): Promise<BeatPlan> {
  const { views, failures } = await prefetchRuns(deps, groups)
  const queues = planProjectQueues(
    groups.map(group => toQueueScope(group, views.get(runKey(group))?.run ?? null)),
    deps.now(),
  )
  return {
    context: group => {
      const view = views.get(runKey(group))
      return { ...(view ? { view } : {}), queue: queues.verdict(group.project, group.epicId) }
    },
    failure: group => failures.get(runKey(group)),
  }
}

/** What one pre-pass produced: a context per epic, and the epics whose run could
 *  not be read at all. The second is not a context with a hole in it -- there is
 *  no beat to run for an epic whose artifact is unreachable. */
export interface BeatPlan {
  context: (group: EpicGroup) => BeatContext
  failure: (group: EpicGroup) => string | undefined
}

/** One pass: a beat for every epic with conversations or an armed run. */
async function scanEpics(deps: SweepDeps): Promise<ScanOutcome<EpicRefusalBucket>> {
  const groups = epicsToBeat(deps)
  const acted: string[] = []
  const refused: Refusal<EpicRefusalBucket>[] = []

  const plan = await planBeatContexts(deps, groups)

  const crashed = (group: EpicGroup, detail: string): null => {
    deps.log(`[epic-sweep] beat crashed for ${group.epicId}: ${detail}`)
    refused.push({ unit: group.epicId, bucket: 'beat-crashed', detail })
    return null
  }

  for (const group of groups) {
    // One epic's failure must never stop the others: a project whose sentinel
    // is down would otherwise freeze every other epic on the box. A run the
    // pre-pass could not read is the same failure one step earlier, so it takes
    // the same bucket rather than a second attempt at the same dead read.
    const unreadable = plan.failure(group)
    const outcome = unreadable
      ? crashed(group, unreadable)
      : await runEpicBeat(deps, group, plan.context(group)).catch(err =>
          crashed(group, err instanceof Error ? err.message : String(err)),
        )
    if (!outcome) continue
    // A beat that took no action is not a beat that said nothing -- `finish`
    // already logged its note, which is where `idleReason` surfaces. Carrying it
    // into the bucket is what makes the refusal countable rather than greppable.
    if (outcome.actions > 0) acted.push(group.epicId)
    else refused.push({ unit: group.epicId, bucket: 'idle', detail: outcome.note })
  }

  return {
    selected: groups.map(g => g.epicId),
    acted,
    refused,
    idleReason: idleReason(groups.length, acted.length),
  }
}

function idleReason(selected: number, acted: number): string | undefined {
  if (acted > 0) return undefined
  if (selected === 0) return 'no epic-tagged conversations and no armed runs'
  return `${selected} epic(s) beaten, none had an action to take`
}

export const epicScanner: Scanner<SweepDeps, EpicRefusalBucket> = {
  id: 'epics',
  tag: '[epic-sweep]',
  selects: 'conversations carrying an epic launch tag, plus every armed run',
  does: 'dispatch',
  buckets: EPIC_REFUSAL_BUCKETS,
  scan: scanEpics,
}
