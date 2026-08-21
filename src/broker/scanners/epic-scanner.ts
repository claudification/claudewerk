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

import { runEpicBeat } from '../epic-executor'
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
  return epicsToWatch(deps.getAllConversations(), deps.isLive, deps.producedOutput)
}

/** One pass: a beat for every epic with conversations or an armed run. */
async function scanEpics(deps: SweepDeps): Promise<ScanOutcome<EpicRefusalBucket>> {
  const groups = epicsToBeat(deps)
  const acted: string[] = []
  const refused: Refusal<EpicRefusalBucket>[] = []

  for (const group of groups) {
    // One epic's failure must never stop the others: a project whose sentinel
    // is down would otherwise freeze every other epic on the box.
    const outcome = await runEpicBeat(deps, group).catch(err => {
      const detail = err instanceof Error ? err.message : String(err)
      deps.log(`[epic-sweep] beat crashed for ${group.epicId}: ${detail}`)
      refused.push({ unit: group.epicId, bucket: 'beat-crashed', detail })
      return null
    })
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
