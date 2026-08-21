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
import { SCANNER_IDS } from '../shared/scanner-ids'
import { isDeletedEpic, listArmedEpics } from './epic-registry'
import { NEVER_ABANDONED, type SeatReaper } from './epic-seat-vitality'

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
   * SEATS THE REGISTRY STILL CALLS LIVE AND THE ENGINE HAS JUST REAPED -- dead
   * by silence rather than by a recorded end. See `epic-seat-vitality.ts`.
   *
   * Their cards have ALREADY been folded as dead: an abandoned seat is absent
   * from `inFlight` and present in `settled` (or `failedLegs`, if it never
   * produced anything), which is the whole point -- the slot comes back.
   *
   * This lane exists so the SETTLE CAN SAY WHICH KIND IT IS. Both a clean exit
   * and a silent death arrive at `settled` and both get one machine
   * `completion` entry, and an overseer reading `log.md` alone must be able to
   * tell "the work finished" from "the worker died" -- one invites a verifier,
   * the other invites somebody to go and look at the worktree. Reported per
   * CONVERSATION, like `failedLegs`, because a card can lose two seats this way.
   */
  abandonedSeats: AbandonedSeat[]
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

/**
 * One seat the engine reaped: the registry still calls it live, and it has held
 * no connection and said nothing for longer than the engine will wait.
 *
 * Carries the evidence rather than a verdict, because the baton entry has to be
 * checkable by a human who does not trust it: WHICH conversation, in WHICH role,
 * from WHICH generation, silent since WHEN, and -- the field that makes the whole
 * thing legible -- the status the registry was still reporting while the seat was
 * gone.
 */
export interface AbandonedSeat {
  cardId: string
  convId: string
  role: 'implementer' | 'verifier'
  /** The generation that dispatched it. */
  gen: number
  /** The conversation's own last sign of life, epoch ms. */
  lastActivity: number
  /** How long it had been silent when the engine gave up on it, ms. */
  silentForMs: number
  /** The status the registry still carried. THE FIELD THAT LIED -- never
   *  `ended`, or `werkLiveness` would have settled the card without help. */
  status: Conversation['status']
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
    abandonedSeats: [],
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
  claimsLive: boolean,
  producedOutput: ProducedOutput,
  reaper: SeatReaper,
  acc: Accumulators,
  group: EpicGroup,
): void {
  // THE REAP, and it happens HERE rather than inside the injected `isLive` so
  // that the group can still SAY a seat was reaped. Folding it into liveness
  // reads identically and loses the one fact the baton needs: whether this
  // card's settle is a finish or a death.
  //
  // Asked only of a seat that CLAIMS to be live -- a conversation already known
  // dead has nothing to reap, and recording it here would turn every ordinary
  // finished seat into a reported corpse.
  const reaping = claimsLive ? reaper(conv) : null
  if (reaping) {
    group.abandonedSeats.push({
      cardId: tag.cardId,
      convId: conv.id,
      role: tag.role,
      gen: tag.gen,
      lastActivity: conv.lastActivity,
      silentForMs: reaping.silentForMs,
      status: conv.status,
    })
  }
  const live = claimsLive && !reaping
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
function absorb(
  conv: Conversation,
  isLive: IsLive,
  producedOutput: ProducedOutput,
  reaper: SeatReaper,
  acc: Accumulators,
): void {
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
  // THE OVERSEER IS DELIBERATELY NOT REAPED HERE. An overseer stuck at a
  // non-`ended` status is the same lie with a different consequence -- it holds
  // `overseerAlive`, which holds the WHOLE beat rather than one slot -- and
  // unfreezing it means granting the lease to a second overseer, which is the
  // one action in this engine that costs a full generation if it is wrong. That
  // is its own card (`epic-overseer-seat-never-reaped`), not a rider on this
  // one: the fix below is bounded to the card lanes it was filed for.
  if (tag.role === 'overseer') {
    if (live) {
      group.overseerAlive = true
      group.liveOverseers.push(conv.id)
    }
    return
  }
  const { epicId, cardId, role, gen } = tag
  if (!cardId) return
  absorbCardSeat(conv, { epicId, cardId, role, gen }, live, producedOutput, reaper, acc, group)
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
  reaper: SeatReaper = NEVER_ABANDONED,
): Map<string, EpicGroup> {
  const acc: Accumulators = { groups: new Map(), cards: new Map(), verifiers: new Map(), outputs: new Map() }
  for (const conv of convs) absorb(conv, isLive, producedOutput, reaper, acc)
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
 * A RESERVED SCANNER LANE IS NOT AN EPIC.
 *
 * `planImplementerSpawn` has no seat without an `EpicLaunchTag`, so a scanner
 * that dispatches a card belonging to no epic -- the work-order scanner is the
 * first -- must stamp SOME epic id. It stamps its own scanner id rather than a
 * real epic's, because a seat wearing a real epic's id gets absorbed into that
 * epic's group, counted as one of its in-flight legs and acknowledged into its
 * baton: two engines dispatching one card.
 *
 * The cost lands here. `groupEpicConversations` keys purely on the tag and the
 * registry keeps conversations after they end, so from the first such dispatch
 * onward the sweep would find a permanent group with no `run.md`, beat it every
 * 45s forever ("armed but nothing is on disk for it"), and show it as a phantom
 * epic on every surface that renders `epicsToWatch`.
 *
 * Stated ONCE, here, rather than as a suppression in the beat, the log or the
 * activity feed: the invariant is that a reserved lane is never an epic, and the
 * next scanner that needs a lane inherits it for free.
 *
 * All five scanner ids are reserved, not just the lanes in use: the ids are the
 * shared vocabulary of `src/shared/scanner-ids.ts`, and a rule that only covered
 * the ones that happen to dispatch today is a rule the sixth scanner has to
 * rediscover. The price is that an epic CARD may not be named exactly `refine`,
 * `nightshift`, `work-orders`, `epics` or `morning-report` -- five words against
 * a whole engine's worth of special cases.
 */
export function isReservedScannerLane(epicId: string): boolean {
  return (SCANNER_IDS as readonly string[]).includes(epicId)
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
  reaper?: SeatReaper,
): EpicGroup[] {
  const groups = groupEpicConversations(convs, isLive, producedOutput, reaper)
  for (const { project, epicId } of listArmedEpics()) {
    // A conversation-derived group is strictly better -- it knows what is in
    // flight -- so an armed entry only fills a gap, never overwrites one.
    if (!groups.has(epicId)) groups.set(epicId, emptyGroup(epicId, project))
  }
  // Filtered on the way OUT, after both sources have been unioned, so neither an
  // arming nor a tagged conversation can smuggle a reserved lane past it.
  // `groupEpicConversations` itself stays unfiltered on purpose: it is the raw
  // registry view, and `epic-inspect` wants to SEE a reserved lane's seats.
  return [...groups.values()].filter(watchable)
}

/**
 * The two ways a group is NOT a run worth watching.
 *
 * A DELETED run is filtered here for exactly the reason a reserved lane is,
 * stated one comment up: the registry keeps a conversation after it ends, so a
 * deleted run's tagged seats would keep producing a group forever -- a phantom
 * epic with no `run.md`, beaten every 45s and rendered on the wall, the badge and
 * the rail. Deleting the artifact cannot fix that on its own, because nothing
 * here reads the filesystem. One predicate for the sweep AND the activity feed,
 * which is the whole reason `epicsToWatch` is shared.
 */
function watchable(group: EpicGroup): boolean {
  return !isReservedScannerLane(group.epicId) && !isDeletedEpic(group.project, group.epicId)
}
