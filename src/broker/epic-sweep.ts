/**
 * THE EPIC SWEEP -- the loop that turns `planBeat`'s decisions into spawns.
 *
 * Mirrors `sweepGuardians` (nightshift-guardians.ts) deliberately: same 45s
 * timer, same "group conversations by their launch tag" shape, same rule that a
 * task with ANY live conversation is being worked and is left alone.
 *
 * The grouping half below is PURE, and that is where the interesting logic
 * lives: which cards are in flight, whether the overseer is alive, and -- the
 * one that matters -- which settled cards the baton has never acknowledged.
 * That last question is what makes the wake self-healing: it is answered from
 * standing state, so a sweep the broker missed (restart, deploy, GC pause) is
 * repaired by the next one instead of losing a settle forever.
 *
 * Effects are injected. A sweep that spawns nothing is still a sweep, and every
 * branch of it is exercised without a broker, a sentinel or a CC process.
 */

import type { EpicLogEntry } from '../shared/epic-run-types'
import type { Conversation } from '../shared/protocol'
import { listArmedEpics } from './epic-registry'

/** What one epic's conversations add up to, from the registry alone. */
export interface EpicGroup {
  epicId: string
  /** Project URI, taken from the conversations themselves. */
  project: string
  /** Cards with a live implementer or verifier right now. */
  inFlight: string[]
  /**
   * Cards with a live VERIFIER specifically. A strict subset of nothing --
   * it overlaps `inFlight` and that is correct, they answer different questions.
   *
   * `inFlight` answers "may this card be dispatched to an implementer"; this
   * answers "does this card already have someone writing its verdict". The beat
   * needs both, and for a long time it only had the first -- so a card in
   * `in-review` asked for a new verifier every sweep, forever.
   */
  inVerify: string[]
  /** Is a conversation holding the overseer seat still alive? */
  overseerAlive: boolean
  /**
   * The ids of the live overseer-seat conversations, not just whether any exist.
   *
   * The lease CAS asks "is THE HOLDER alive", and `overseerAlive` cannot answer
   * that -- it says only that SOME overseer lives, which is a different question
   * and reads `true` in exactly the case the CAS exists to stop (a second
   * overseer already running alongside a stale holder).
   */
  liveOverseers: string[]
  /** Cards whose every backing conversation has ended. Candidates for a wake. */
  settled: string[]
  /** The highest generation seen across this epic's conversations. Diagnostic
   *  only -- the run file owns the real counter, this just makes a mismatch
   *  visible in the log instead of silent. */
  maxGenSeen: number
}

/** Liveness is the registry's to know; the caller supplies the predicate. */
export type IsLive = (conv: Conversation) => boolean

/** epicId -> cardId -> "does ANY conversation for this card still live". The
 *  OR-fold is the whole point: a card retried after a crash has two
 *  conversations, and the older dead one must not settle it out from under the
 *  live retry. */
type CardLiveness = Map<string, Map<string, boolean>>

function emptyGroup(epicId: string, project: string): EpicGroup {
  return {
    epicId,
    project,
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    maxGenSeen: 0,
  }
}

/** OR-fold one card's liveness. Its own function because the OR is the subtle
 *  part -- `set(card, live)` would let a dead retry-predecessor settle a card
 *  that is currently being worked. */
function noteCardLiveness(cards: CardLiveness, epicId: string, cardId: string, live: boolean): void {
  const byCard = cards.get(epicId) ?? new Map<string, boolean>()
  byCard.set(cardId, Boolean(byCard.get(cardId)) || live)
  cards.set(epicId, byCard)
}

/** Fold one conversation into the accumulators. Split out so the grouping pass
 *  reads as "for each conversation, absorb it" and nothing else. */
function absorb(
  conv: Conversation,
  isLive: IsLive,
  groups: Map<string, EpicGroup>,
  cards: CardLiveness,
  verifiers: CardLiveness,
): void {
  const tag = conv.launchConfig?.epic
  if (!tag?.epicId) return

  const group = groups.get(tag.epicId) ?? emptyGroup(tag.epicId, conv.project)
  group.maxGenSeen = Math.max(group.maxGenSeen, tag.gen)
  groups.set(tag.epicId, group)

  const live = isLive(conv)
  if (tag.role === 'overseer') {
    if (live) {
      group.overseerAlive = true
      group.liveOverseers.push(conv.id)
    }
    return
  }
  if (!tag.cardId) return
  noteCardLiveness(cards, tag.epicId, tag.cardId, live)
  // Second, role-scoped fold. The combined one above still owns settle/dispatch;
  // this one exists so the beat can ask "is a VERDICT already being written" --
  // a question the combined bit cannot answer, which is how one card ended up
  // with eight simultaneous verifiers.
  if (tag.role === 'verifier') noteCardLiveness(verifiers, tag.epicId, tag.cardId, live)
}

/** Resolve the per-card liveness fold into the two lanes the beat consumes. */
/** Live vs dead across ALL roles -- the in-flight / settled split. */
function foldWorkLanes(group: EpicGroup, byCard: Map<string, boolean>): void {
  for (const [cardId, live] of byCard) {
    ;(live ? group.inFlight : group.settled).push(cardId)
  }
  group.inFlight.sort()
  group.settled.sort()
}

/** Verifier-role only, and only the LIVE half: a dead verifier is not a reason
 *  to withhold a verdict, it is a reason to write one. */
function foldVerifyLane(group: EpicGroup, byCard: Map<string, boolean>): void {
  for (const [cardId, live] of byCard) if (live) group.inVerify.push(cardId)
  group.inVerify.sort()
}

/** Resolve the per-card liveness folds into the lanes the beat consumes. */
function splitLanes(groups: Map<string, EpicGroup>, cards: CardLiveness, verifiers: CardLiveness): void {
  for (const [epicId, byCard] of cards) {
    const group = groups.get(epicId)
    if (group) foldWorkLanes(group, byCard)
  }
  for (const [epicId, byCard] of verifiers) {
    const group = groups.get(epicId)
    if (group) foldVerifyLane(group, byCard)
  }
}

/**
 * Group every epic-tagged conversation by epic. A card counts as settled only
 * when NO backing conversation is live.
 */
export function groupEpicConversations(convs: readonly Conversation[], isLive: IsLive): Map<string, EpicGroup> {
  const groups = new Map<string, EpicGroup>()
  const cards: CardLiveness = new Map()
  const verifiers: CardLiveness = new Map()
  for (const conv of convs) absorb(conv, isLive, groups, cards, verifiers)
  splitLanes(groups, cards, verifiers)
  return groups
}

/**
 * Settled cards the baton has never acknowledged. THE standing question the wake
 * is built on.
 *
 * A card is acknowledged by a `completion` or `verdict` entry naming it. Note
 * that a `dispatch` entry does NOT acknowledge anything -- it records that work
 * started, and treating it as an acknowledgement is exactly how a settle would
 * go unnoticed.
 */
const ACKNOWLEDGING_KINDS = new Set<EpicLogEntry['kind']>(['completion', 'verdict'])

export function unacknowledgedCards(settled: readonly string[], baton: readonly EpicLogEntry[]): string[] {
  const acknowledged = new Set(baton.filter(e => ACKNOWLEDGING_KINDS.has(e.kind) && e.cardId).map(e => e.cardId))
  return settled.filter(cardId => !acknowledged.has(cardId))
}

/**
 * Does the generation the registry saw disagree with the run file? Only ever a
 * LOG line -- the run file is authoritative and the sweep must not "fix" it.
 * A persistent mismatch means spawns are being tagged with a stale generation,
 * which would make every wake look stale and quietly freeze the epic.
 */
export function generationMismatch(group: EpicGroup, runGen: number): string | null {
  return group.maxGenSeen > runGen
    ? `conversations tagged gen ${group.maxGenSeen} but run.md says ${runGen} -- spawns may be racing the lease`
    : null
}

/**
 * EVERY EPIC WORTH LOOKING AT: the ones with conversations, PLUS the ones merely
 * armed.
 *
 * The second half is not an optimisation. Without it a freshly armed run has no
 * conversations, so nothing sees it, so it never dispatches, so it never gets
 * conversations -- the engine could only find epics that were already running.
 * The first live smoke on 2026-08-18 found exactly that.
 *
 * Shared by the sweep (which beats these) and the activity feed (which reports
 * them). They MUST agree: a badge that counted a different set than the engine
 * beat would be a UI that lies about the engine by construction.
 */
export function epicsToWatch(convs: readonly Conversation[], isLive: IsLive): EpicGroup[] {
  const groups = groupEpicConversations(convs, isLive)
  for (const { project, epicId } of listArmedEpics()) {
    // A conversation-derived group is strictly better -- it knows what is in
    // flight -- so an armed entry only fills a gap, never overwrites one.
    if (!groups.has(epicId)) groups.set(epicId, emptyGroup(epicId, project))
  }
  return [...groups.values()]
}
