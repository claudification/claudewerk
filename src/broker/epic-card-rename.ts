/**
 * A RENAMED CARD STILL ANSWERS TO ITS OLD NAME.
 *
 * `epic-spawn-plan.ts` stamps the card id into a seat's launch tag when the
 * conversation is created, and nothing ever revisits it. `epic-sweep.ts` reads
 * that frozen value back to decide whether a card is being worked. So the whole
 * in-flight question is keyed on THE ID THE CARD HAD AT SPAWN TIME -- rename the
 * file and the live conversation goes on answering to a key nobody asks about,
 * while the beat asks about the new id, finds nothing, and correctly concludes
 * from wrong input that the card is unworked.
 *
 * That is what happened on 2026-08-20: a card renamed at 02:46 collected a
 * second implementer at 03:15 while the first was still typing into the same
 * file. The same frozen key loses a card's verifier and its settle-ack, so a
 * renamed card can also collect duplicate verifiers and re-wake a generation
 * per sweep for work that finished.
 *
 * THE SHAPE, and why it is `renamed_from:` rather than a stable non-filename
 * key: the filename is the human handle everyone on the board types, links and
 * greps, and a second identifier would have to be kept in sync by hand -- the
 * same class of drift as the frozen ack. So the card carries its own history and
 * the fold below is the only reader of it.
 *
 * WHAT THIS IS NOT: it does not rewrite history. Baton entries keep the id they
 * were written with, because they are acknowledgement keys and rewriting them
 * would make settled cards read as unacknowledged forever. Only the LIVE view --
 * the lanes a beat decides from -- is translated, and only on the way in.
 *
 * Pure. Takes the board and the group the sweep already built, returns new
 * values, touches nothing.
 */

import type { ProjectTaskMeta } from '../shared/project-task-types'
import type { EpicGroup } from './epic-sweep'

/** Old card id -> the id that card goes by now. */
export type CardRenames = ReadonlyMap<string, string>

/**
 * Every rename the board knows about, in one pass over the cards.
 *
 * A card naming ITSELF is dropped rather than stored: it is a no-op mapping that
 * would only make `applyCardRenames` look like it did something.
 */
export function cardRenames(cards: readonly ProjectTaskMeta[]): CardRenames {
  const out = new Map<string, string>()
  for (const card of cards) {
    for (const old of card.renamedFrom ?? []) {
      if (old && old !== card.slug) out.set(old, card.slug)
    }
  }
  return out
}

/** The id a card goes by now. Unknown ids pass through untouched -- an id with
 *  no rename recorded IS its own current name. */
function current(renames: CardRenames, id: string): string {
  return renames.get(id) ?? id
}

/** One lane, translated. Deduplicated because two seats -- one launched before a
 *  rename and one after -- are two entries for ONE card once they are folded. */
function lane(ids: readonly string[], renames: CardRenames): string[] {
  return [...new Set(ids.map(id => current(renames, id)))].sort()
}

/**
 * The group as the BOARD sees it: every card id translated through the renames
 * the board records.
 *
 * `settled` and `unspawnable` are then filtered against the live set, and that
 * is not tidiness -- it is `noteCardLiveness`'s OR-fold applied one level up.
 * Before the merge, a dead seat under the old id and a live one under the new id
 * are two different cards and land in two different lanes; after it they are one
 * card that is both settled and in flight. The live answer wins, for the same
 * reason it wins inside the sweep: a dead predecessor must not settle a card out
 * from under the seat currently working it.
 */
export function applyCardRenames(group: EpicGroup, renames: CardRenames): EpicGroup {
  if (renames.size === 0) return group
  const inFlight = lane(group.inFlight, renames)
  const live = new Set(inFlight)
  return {
    ...group,
    inFlight,
    inVerify: lane(group.inVerify, renames),
    settled: lane(group.settled, renames).filter(id => !live.has(id)),
    unspawnable: lane(group.unspawnable, renames).filter(id => !live.has(id)),
    // Per CONVERSATION, not per card, so these are not deduplicated: two failed
    // launches under two names are still two attempts against the retry ceiling.
    failedLegs: group.failedLegs.map(leg => ({ ...leg, cardId: current(renames, leg.cardId) })),
  }
}

/**
 * The acknowledged set, plus the ids those acknowledgements now stand for.
 *
 * Additive on purpose. The old id stays in the set because old baton entries
 * still name it and `acknowledgedCardIds` folds the whole log; the new id is
 * added because `settled` has just been translated into it, and without this the
 * beat would ask "has `new` been acknowledged?" of a log that only ever wrote
 * `old` -- and wake a generation for a card that settled hours ago.
 */
export function renameAwareAcks(acknowledged: readonly string[], renames: CardRenames): string[] {
  if (renames.size === 0) return [...acknowledged]
  return [...new Set(acknowledged.flatMap(id => [id, current(renames, id)]))]
}

/**
 * Live seats whose card id matches NOTHING on the board -- an orphaned
 * acknowledgement key.
 *
 * This is what a rename with no `renamed_from:` looks like from the outside, and
 * it is exactly the state that cost the 2026-08-20 run a seat while the engine
 * said nothing at all. A card deleted or archived out from under a live worker
 * lands here too, and is equally worth a line.
 *
 * Call it AFTER `applyCardRenames`, or every recorded rename reads as an orphan.
 *
 * AN EMPTY BOARD RETURNS NOTHING. A board read that failed or raced a sentinel
 * restart comes back empty, and warning that every live seat is orphaned is the
 * one way to make this check ignorable.
 */
export function orphanedCardIds(group: EpicGroup, cards: readonly ProjectTaskMeta[]): string[] {
  if (cards.length === 0) return []
  const board = new Set(cards.map(c => c.slug))
  return group.inFlight.filter(id => !board.has(id)).sort()
}

/** The WARN line for `orphanedCardIds`, naming the cause a reader can act on. */
export function orphanedAckLine(orphans: readonly string[]): string {
  return (
    `WARN orphaned ack: live seat(s) hold card id(s) no card on the board carries -- ${orphans.join(', ')}. ` +
    'A card renamed without a `renamed_from:` line looks exactly like this, and the next beat will ' +
    'dispatch a duplicate onto work already in flight.'
  )
}
