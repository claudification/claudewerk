/**
 * `#needs-refine`, DRAINED BY THE ENGINE -- what counts as evidence a werk-refiner
 * actually refined the card.
 *
 * `tag-clear.ts` owns the rule ("a seat ran, and the work landed"); this file
 * answers the second half for exactly one tag, because only this tag knows what
 * its seat was sent to do.
 *
 * THE EVIDENCE IS THAT THE CARD FILE CHANGED AFTER THE SEAT STARTED, and it
 * cannot be the card's status. `WERK-REFINER@1` DENIES `project_set_status` -- "a
 * card that got clearer did not get done" is the order's own rule, enforced by a
 * deny rule rather than by prose -- so a status advance is the one signal a
 * correctly-behaving werk-refiner can never produce. What it does produce is a
 * rewritten body, a priority, tags and a `model:` hint, all of them writes to one
 * file. `mtime` is that file's, carried on every card the board hands back.
 *
 * MTIME VS THE SEAT'S START IS A CROSS-CLOCK COMPARISON, and it is worth naming
 * which way it fails. `startedAt` is stamped by the BROKER; `mtime` is stat'd by
 * the SENTINEL that owns the repo. Same host today, so the skew is zero. On a
 * remote sentinel running BEHIND the broker the drain under-reads (a refined card
 * keeps its tag until somebody touches it again) -- the visible failure. Running
 * AHEAD it could over-read a card tagged within the skew window and clear a tag
 * whose seat did nothing, which is the failure that matters, and the reason this
 * is documented rather than left for someone to discover.
 *
 * IT IS STILL THE RIGHT TRADE, because the alternative is worse in the failure
 * mode that actually happens here. Remembering the card's mtime at dispatch would
 * be clock-free and would also be STATE -- state a broker restart drops, and this
 * broker restarts often. A drain that forgets its baseline never clears anything
 * again, silently, which is the stuck tag this card exists to end. Both facts
 * this file compares are durable: conversations persist their `startedAt`, mtime
 * lives on disk. A restart mid-refine changes nothing.
 *
 * THE LATEST SEAT'S START, NOT THE FIRST. A second werk-refiner exists only because
 * the first produced no evidence, so "did the most recent attempt change the
 * file?" is the question. Measured from the first, a card edited by attempt one
 * and abandoned by attempt two would read as freshly refined.
 */

import { NEEDS_REFINE_TAG } from '../shared/epic-ready'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { Conversation } from '../shared/protocol'
import { emptyGroup, groupEpicConversations, type ProducedOutput } from './epic-sweep'
import { REFINE_EPIC_ID } from './scanners/refine-scanner'
import { type DrainReport, drainTag, type TagClearInput } from './tag-clear'
import type { IsLive } from './werk-liveness'

/** The effects one refine drain needs. The first three are the scanner's own
 *  liveness inputs, deliberately -- the drain and the scan must not be able to
 *  disagree about which seats are alive. */
export interface RefineDrainDeps {
  cards: readonly ProjectTaskMeta[]
  getAllConversations: () => Conversation[]
  isLive: IsLive
  producedOutput: ProducedOutput
  /** Drop `needs-refine` from this card. `false` = the board refused the write. */
  untag: (slug: string) => Promise<boolean>
  log: (line: string) => void
}

/**
 * When the most recent werk-refiner seat for each card STARTED.
 *
 * Keyed off the reserved `refine` lane (`launchConfig.epic.epicId`), which is the
 * same key `refine-scanner.ts` counts attempts by -- a seat tagged with any real
 * epic would be somebody else's leg.
 */
function latestSeatStart(convs: readonly Conversation[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const conv of convs) {
    const tag = conv.launchConfig?.epic
    if (tag?.epicId !== REFINE_EPIC_ID || !tag.cardId) continue
    const seen = out.get(tag.cardId)
    if (seen === undefined || conv.startedAt > seen) out.set(tag.cardId, conv.startedAt)
  }
  return out
}

/**
 * Card -> the four facts the rule asks for.
 *
 * `seatSettled` comes from the SHARED liveness fold rather than "the conversation
 * ended": `groupEpicConversations` is what already distinguishes a seat that ran
 * and finished from one that died before writing a single transcript entry, and
 * the refine scanner refuses on the identical sets. A seat that never produced
 * output is `unspawnable`, not settled, so it can never clear a tag.
 */
export function refineEvidence(deps: RefineDrainDeps): (card: ProjectTaskMeta) => TagClearInput {
  const convs = deps.getAllConversations()
  const group =
    groupEpicConversations(convs, deps.isLive, deps.producedOutput).get(REFINE_EPIC_ID) ??
    emptyGroup(REFINE_EPIC_ID, '')
  const live = new Set(group.inFlight)
  const settled = new Set(group.settled)
  const startedAt = latestSeatStart(convs)
  return card => {
    const start = startedAt.get(card.slug)
    return {
      tagged: card.tags.includes(NEEDS_REFINE_TAG),
      seatLive: live.has(card.slug),
      seatSettled: settled.has(card.slug),
      workLanded: start !== undefined && card.mtime > start,
    }
  }
}

/** One drain pass over a project's board. */
export function drainRefineTag(deps: RefineDrainDeps): Promise<DrainReport> {
  return drainTag(NEEDS_REFINE_TAG, {
    cards: deps.cards,
    evidence: refineEvidence(deps),
    untag: deps.untag,
    log: deps.log,
  })
}
