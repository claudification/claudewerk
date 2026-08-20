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
  /**
   * Cards whose every backing conversation has ended AND at least one of them
   * produced something. Candidates for a wake.
   *
   * The second half of that sentence is the 2026-08-20 fix. A spawn that dies
   * in 1.2s also ends with every backing conversation dead, and folding it in
   * here told the overseer a card had reached a terminal state when the seat
   * never started -- one wasted generation per sweep, forever, with no verdict
   * ever written. See `failedLegs`.
   */
  settled: string[]
  /**
   * Dead seats that produced NOTHING -- a launch that failed, not a leg that
   * finished. Reported per conversation rather than per card because the baton
   * entry names the conversation, and because a card can fail to launch twice.
   *
   * A card with only failed legs appears in NEITHER `inFlight` nor `settled`:
   * nothing is working it and nothing has been done to it, which is precisely
   * "dispatchable again".
   */
  failedLegs: FailedLeg[]
  /**
   * Cards that have burned `MAX_LAUNCH_ATTEMPTS` seats without one of them
   * producing anything. THE BOUND ON THE RETRY PATH.
   *
   * Leaving a failed launch dispatchable is right exactly once per attempt and
   * catastrophic without a ceiling: gen 2 of `epic-the-wall-ii` wrote thirteen
   * `dispatch` entries for one card, thirteen seats died, and the engine would
   * happily have written a fourteenth. A card in here is dispatched no further
   * -- it goes into `idleReason`, which drives a dry generation, which wakes the
   * overseer once and parks the run on the second. Visible and stopped, rather
   * than retried forever.
   */
  unspawnable: string[]
  /**
   * EVERY conversation this epic has ever had in the registry -- every role,
   * live or dead. The denominator of the run's spend cap (epic-executor.ts).
   *
   * Deliberately not derived from the lanes above: those are keyed on CARDS and
   * drop the overseer entirely, drop a card's earlier retries once a later seat
   * settles it, and drop failed launches -- all of which still cost money. A cap
   * fed from them would under-count exactly the runs that are going wrong.
   */
  convIds: string[]
  /** The highest generation seen across this epic's conversations. Diagnostic
   *  only -- the run file owns the real counter, this just makes a mismatch
   *  visible in the log instead of silent. */
  maxGenSeen: number
}

/** One dispatched seat that died without producing anything. */
export interface FailedLeg {
  cardId: string
  convId: string
  role: 'implementer' | 'verifier'
  /** The generation that dispatched it -- so the baton entry can say WHEN. */
  gen: number
}

/** Liveness is the registry's to know; the caller supplies the predicate. */
export type IsLive = (conv: Conversation) => boolean

/**
 * Did this conversation ever produce a transcript entry? The transcript lives
 * in the store, not on the `Conversation`, so like liveness it is injected.
 *
 * DEFAULTS TO TRUE when omitted, and that direction is deliberate: an unknown
 * answer must read as "it produced something", which yields today's behaviour
 * (the leg settles). The opposite default would let a caller that never wired
 * this up -- or a store that has forgotten an old conversation -- re-dispatch
 * finished work.
 */
export type ProducedOutput = (conv: Conversation) => boolean

/** epicId -> cardId -> "does ANY conversation for this card still live". The
 *  OR-fold is the whole point: a card retried after a crash has two
 *  conversations, and the older dead one must not settle it out from under the
 *  live retry. */
type CardLiveness = Map<string, Map<string, boolean>>

/**
 * How many seats a card may lose to a failed launch before the engine stops
 * sending more.
 *
 * THREE, not one: a spawn can fail transiently (a sentinel mid-restart, a name
 * race), and refusing to retry at all would strand a healthy card on one bad
 * second. Three is also small enough that the DETERMINISTIC failure this card
 * was filed for -- a card id too long to be a worktree name -- costs three
 * spawns instead of the thirteen gen 2 actually spent.
 */
export const MAX_LAUNCH_ATTEMPTS = 3

/** An epic with no conversations still has a live picture -- an empty one.
 *  Exported because `epic-inspect` needs the identical zero value: two copies
 *  drift the moment `EpicGroup` gains a field, and one of the two readers then
 *  reports a shape the other cannot. */
export function emptyGroup(epicId: string, project: string): EpicGroup {
  return {
    epicId,
    project,
    inFlight: [],
    inVerify: [],
    overseerAlive: false,
    liveOverseers: [],
    settled: [],
    failedLegs: [],
    unspawnable: [],
    convIds: [],
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

/** The three folds one grouping pass builds up, in one bag so `absorb` takes a
 *  parameter list a human can read. */
interface Accumulators {
  groups: Map<string, EpicGroup>
  /** Any conversation for this card still alive? */
  cards: CardLiveness
  /** Any VERIFIER for this card still alive? */
  verifiers: CardLiveness
  /** Any conversation for this card ever produce anything? */
  outputs: CardLiveness
}

/** A card-holding seat -- implementer or verifier -- folded into all three
 *  per-card accumulators. Its own function so `absorb` stays "which kind of
 *  conversation is this" and nothing else. */
function absorbCardSeat(
  conv: Conversation,
  tag: { epicId: string; cardId: string; role: FailedLeg['role']; gen: number },
  live: boolean,
  producedOutput: ProducedOutput,
  acc: Accumulators,
  group: EpicGroup,
): void {
  noteCardLiveness(acc.cards, tag.epicId, tag.cardId, live)
  // Second, role-scoped fold. The combined one above still owns settle/dispatch;
  // this one exists so the beat can ask "is a VERDICT already being written" --
  // a question the combined bit cannot answer, which is how one card ended up
  // with eight simultaneous verifiers.
  if (tag.role === 'verifier') noteCardLiveness(acc.verifiers, tag.epicId, tag.cardId, live)

  const output = producedOutput(conv)
  noteCardLiveness(acc.outputs, tag.epicId, tag.cardId, output)
  // A LIVE seat with nothing yet is young, not dead. Only a finished one that
  // never said anything is a failed launch.
  if (!live && !output) {
    group.failedLegs.push({ cardId: tag.cardId, convId: conv.id, role: tag.role, gen: tag.gen })
  }
}

/** Fold one conversation into the accumulators. Split out so the grouping pass
 *  reads as "for each conversation, absorb it" and nothing else. */
function absorb(conv: Conversation, isLive: IsLive, producedOutput: ProducedOutput, acc: Accumulators): void {
  const tag = conv.launchConfig?.epic
  if (!tag?.epicId) return

  const group = acc.groups.get(tag.epicId) ?? emptyGroup(tag.epicId, conv.project)
  group.maxGenSeen = Math.max(group.maxGenSeen, tag.gen)
  // Recorded HERE, before the role split below returns early for the overseer:
  // the overseer is a seat like any other and its generations are billed like
  // any other. A ledger that forgets the supervisor is a ledger that under-reads
  // precisely on the runs that wake it most.
  group.convIds.push(conv.id)
  acc.groups.set(tag.epicId, group)

  const live = isLive(conv)
  if (tag.role === 'overseer') {
    if (live) {
      group.overseerAlive = true
      group.liveOverseers.push(conv.id)
    }
    return
  }
  const { epicId, cardId, role, gen } = tag
  if (!cardId) return
  absorbCardSeat(conv, { epicId, cardId, role, gen }, live, producedOutput, acc, group)
}

/**
 * Live vs dead vs never-started -- the in-flight / settled split, with the
 * third case that used to be silently folded into the second.
 *
 * A card whose every conversation is dead AND silent lands in no lane at all.
 * That is the point: `inFlight` would withhold it from dispatch and `settled`
 * would claim it finished, and neither is true of work that never began.
 */
function foldWorkLanes(group: EpicGroup, byCard: Map<string, boolean>, outputs: Map<string, boolean>): void {
  const failures = new Map<string, number>()
  for (const leg of group.failedLegs) failures.set(leg.cardId, (failures.get(leg.cardId) ?? 0) + 1)

  for (const [cardId, live] of byCard) {
    if (live) {
      group.inFlight.push(cardId)
      continue
    }
    // Anything that ever produced output settles, however many seats died
    // around it -- a card that eventually worked is not unspawnable.
    if (outputs.get(cardId) ?? true) {
      group.settled.push(cardId)
      continue
    }
    if ((failures.get(cardId) ?? 0) >= MAX_LAUNCH_ATTEMPTS) group.unspawnable.push(cardId)
  }
  group.inFlight.sort()
  group.settled.sort()
  group.unspawnable.sort()
}

/** Verifier-role only, and only the LIVE half: a dead verifier is not a reason
 *  to withhold a verdict, it is a reason to write one. */
function foldVerifyLane(group: EpicGroup, byCard: Map<string, boolean>): void {
  for (const [cardId, live] of byCard) if (live) group.inVerify.push(cardId)
  group.inVerify.sort()
}

/** Resolve the per-card liveness folds into the lanes the beat consumes. */
function splitLanes(acc: Accumulators): void {
  for (const [epicId, byCard] of acc.cards) {
    const group = acc.groups.get(epicId)
    if (group) foldWorkLanes(group, byCard, acc.outputs.get(epicId) ?? new Map())
  }
  for (const [epicId, byCard] of acc.verifiers) {
    const group = acc.groups.get(epicId)
    if (group) foldVerifyLane(group, byCard)
  }
}

/**
 * Group every epic-tagged conversation by epic. A card counts as settled only
 * when NO backing conversation is live AND at least one of them produced
 * something -- see `EpicGroup.settled`.
 */
export function groupEpicConversations(
  convs: readonly Conversation[],
  isLive: IsLive,
  producedOutput: ProducedOutput = () => true,
): Map<string, EpicGroup> {
  const acc: Accumulators = { groups: new Map(), cards: new Map(), verifiers: new Map(), outputs: new Map() }
  for (const conv of convs) absorb(conv, isLive, producedOutput, acc)
  splitLanes(acc)
  return acc.groups
}

/**
 * Settled cards the baton has never acknowledged. THE standing question the wake
 * is built on.
 *
 * Takes the ACKNOWLEDGED SET, not the baton. It used to take the baton and fold
 * it here, which reads identically and is quietly wrong: the baton the beat
 * holds is a 20-entry prompt tail, so this answered "acknowledged in the last 20
 * entries" while claiming to answer "acknowledged, ever". `acknowledgedCardIds`
 * (epic-log.ts) folds the whole log, sentinel-side, and the type change is the
 * point -- the old signature made the wrong call the natural one to write.
 */
export function unacknowledgedCards(settled: readonly string[], acknowledged: readonly string[]): string[] {
  const seen = new Set(acknowledged)
  return settled.filter(cardId => !seen.has(cardId))
}

/**
 * Failed legs the baton has not recorded yet.
 *
 * Keyed on the CONVERSATION, not the card, and that is the whole difference
 * from `unacknowledgedCards`. A card can fail to launch, be re-dispatched, and
 * fail again -- three attempts is three entries, because "we tried and it died"
 * is a fact about an attempt. Keyed on the card, the second failure would be
 * silent and a permanently unspawnable card would look like one bad night.
 *
 * A `completion` deliberately does NOT suppress one: conflating the two is the
 * bug this whole lane exists to end.
 */
export function unacknowledgedFailedLegs(legs: readonly FailedLeg[], baton: readonly EpicLogEntry[]): FailedLeg[] {
  const recorded = new Set(baton.filter(e => e.kind === 'dispatch-failed').map(e => e.convId))
  return legs.filter(leg => !recorded.has(leg.convId))
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
export function epicsToWatch(
  convs: readonly Conversation[],
  isLive: IsLive,
  producedOutput?: ProducedOutput,
): EpicGroup[] {
  const groups = groupEpicConversations(convs, isLive, producedOutput)
  for (const { project, epicId } of listArmedEpics()) {
    // A conversation-derived group is strictly better -- it knows what is in
    // flight -- so an armed entry only fills a gap, never overwrites one.
    if (!groups.has(epicId)) groups.set(epicId, emptyGroup(epicId, project))
  }
  return [...groups.values()]
}
