/**
 * ONE BEAT of an epic run -- the decision, with no side effects.
 *
 * Everything the engine does between "something settled" and "something was
 * spawned" happens here, as a pure function from (run, board plan, what is
 * alive) to a list of ACTIONS. The caller performs them. That split is what
 * makes the interesting failures testable: double wakes, the dry-generation
 * park, the generation ceiling, and the window gate are all decisions, and none
 * of them needs a broker, a sentinel or a spawn to exercise.
 *
 * WHY A WAKE IS STATE-BASED, NOT EVENT-BASED. The obvious design fires the
 * werk-master from a "worker ended" event. That loses a settle whenever the
 * werk-master is mid-turn, and double-fires whenever two workers end together.
 * Instead the beat asks a standing question -- "is there a settled card the
 * baton has not acknowledged?" -- so a missed sweep is repaired by the next one
 * and a duplicate is refused by the lease CAS. Self-healing beats bookkeeping.
 */

import { LEASE_STALE_MS } from '../shared/epic-lease'
import type { EpicPlan } from '../shared/epic-ready'
import { elapsedRunMinutes, formatUsd } from '../shared/epic-run-caps'
import type { EpicWakeReason } from '../shared/epic-run-types'
import { gatedBy, whenWaitingLine } from '../shared/epic-when'
import { formatDuration } from '../shared/format-duration'
import type { EpicRunSnapshot } from '../shared/protocol'
import type { HeadroomVerdict } from './epic-headroom'
import type { QueueVerdict } from './epic-queue'

/** What the caller should do. Order in the array is the order to do it in. */
export type EpicAction =
  /** `reason` is the WAKE REASON the generation is recorded under, not free text:
   *  it reaches the werk-master prompt verbatim ("Woken by: ..."), so an untyped
   *  string here is a typo that renders to a live agent. */
  | { kind: 'wake-werk-master'; expectGen: number; reason: EpicWakeReason }
  /** `dependsOn` rides along purely so the werk-worker prompt can order a base
   *  check -- the dispatch DECISION already happened, in `epic-cards.ts`, from
   *  card lanes. Nothing downstream re-reads it to gate anything. */
  | { kind: 'dispatch'; cardId: string; dependsOn?: readonly string[] }
  | { kind: 'verify'; cardId: string }
  | { kind: 'park'; reason: string }
  | { kind: 'complete' }
  /** Generation 0: analyse the board before anything is dispatched. Carries the
   *  fingerprint to compare against when it settles. */
  | { kind: 'plan'; baseline: string }
  /** The planning generation settled and left the board as it found it. */
  | { kind: 'plan-accept' }
  /** The planning generation rewrote the board. Stop and show Jonas. */
  | { kind: 'plan-checkpoint'; before: string; after: string }

export interface EpicBeatInput {
  run: EpicRunSnapshot
  /**
   * THE WERK-MASTER GENERATION, FROM THE LEASE ON THE EPIC CARD -- never from the
   * run artifact.
   *
   * Its own input rather than a field read off `run` because this number is the
   * one the CAS compares (`evaluateLease`), and every `expectGen` below is
   * eventually handed back to it. While the run file carried a mirror of it, the
   * beat quoted the mirror and the CAS compared the card: on 2026-08-20
   * `epic-the-wall-ii` beat every 45 seconds for hours on `stale wake: expected
   * gen 12, epic is at gen 11`, spawning nothing, with every panel surface
   * reporting RUNNING.
   *
   * The mirror is gone (`EpicRunMeta`), so the two cannot drift any more -- but
   * the beat still takes the generation explicitly, because a pure decision that
   * reads it out of a bag it was handed cannot be argued with about WHICH copy
   * it read.
   *
   * 0 means the epic has never been woken, which is what `evaluateLease` expects
   * from a first wake.
   */
  gen: number
  plan: EpicPlan
  /** Card ids with a live werk-worker or werk-verifier right now. */
  inFlight: readonly string[]
  /** Is the lease holder's conversation still alive? */
  werkMasterAlive: boolean
  /**
   * WHEN THE CURRENT LEASE WAS TAKEN -- `view.lease.at`, verbatim. The TTL half
   * of the werk-master gate, and the reason a wedged supervisor no longer stops a
   * run forever.
   *
   * THE TIMESTAMP AND NOT THE `EpicLease`, even though the caller holds the whole
   * object. `gen` is already its own input for the reason its own docstring
   * gives, and handing the beat a second route to the same generation is exactly
   * the "which copy did it read" argument that mirror cost this engine hours on
   * 2026-08-20. One field, one question: how long has this grip been held.
   *
   * ABSENT MEANS NO TTL -- today's behaviour, an unbounded hold -- which is the
   * same convention `queue` and `producedOutput` use: a caller that has not wired
   * this up must not have its supervisor displaced on an age nobody supplied.
   */
  leaseAt?: string
  /**
   * THE CONVERSATION HOLDING THIS EPIC IS A CORPSE, and the fold has just said so
   * for the first time (`lostWerkMaster`, epic-sweep.ts).
   *
   * A SPENT FACT, not a standing one, and the difference is what stops it looping.
   * `abandonedWerkMasters` never empties -- a dead conversation stays dead and stays
   * in the registry -- so a beat that woke from the LANE would wake every 45
   * seconds for the life of the broker. The caller keys it on the LEASE HOLDER
   * instead, and a granted replacement moves the lease, so this reads false again
   * on the very next beat.
   *
   * Absent means no reap, which is every caller that has not wired a reaper up.
   */
  werkMasterLost?: boolean
  /** Cards that reached a terminal state with no `completion` entry in the baton.
   *  The standing question that drives the wake. */
  unacknowledged: readonly string[]
  /** Is the project's nightshift window open right now? Only consulted when the
   *  run's `when` axis carries `window` -- `now` ignores the clock entirely. */
  windowOpen: boolean
  /**
   * What the QUEUE gate says about this epic this beat -- computed across every
   * scope in the project, because "is anything else running" is the one admission
   * question a single epic's beat cannot answer for itself (`epic-queue.ts`).
   *
   * ABSENT MEANS NO GATE, the same convention `scannerOptIn` and `producedOutput`
   * use: a caller that has not computed the project's verdict gets today's
   * behaviour rather than a silently withheld dispatch.
   */
  queue?: QueueVerdict
  /**
   * WHETHER ANY PROFILE THIS RUN COULD USE HAS PLAN HEADROOM LEFT
   * (`epic-headroom.ts`, computed across every connected sentinel).
   *
   * THE VERDICT AND NOT THE READINGS, exactly like `queue` above: the beat is a
   * pure decision and the arithmetic over per-profile 5h windows -- which
   * readings are stale, which profile binds, when it frees -- belongs to the
   * module that owns the rule, not to a decision that would then have to be
   * tested through it.
   *
   * ABSENT MEANS NO GATE, the same convention as `queue` and `producedOutput`.
   * A caller that has not wired telemetry up dispatches as it does today rather
   * than withholding work on evidence nobody supplied.
   */
  headroom?: HeadroomVerdict
  /**
   * THIS BEAT WAS ASKED FOR BY HAND -- `epic_run action=beat`, not the 45s sweep.
   *
   * It overrides the two gates that are the RUN'S OWN -- the APPOINTMENT
   * (`when=at:<iso>`) and HEADROOM -- and nothing else. The appointment is a
   * note-to-self a human made about when to start; pressing BEAT NOW is that same
   * human saying "actually, now", and refusing them would leave no way to start an
   * armed run early short of re-arming it. Headroom is the same shape: it is this
   * run's money being spent into a throttled account, and the human pressing the
   * button owns that call. Both overrides are RECORDED.
   *
   * `window` and `queue` are deliberately NOT overridable and never have been.
   * They are not one person's preference: `window` is a project policy about when
   * the box may be busy, and `queue` is a promise made to every OTHER epic that
   * nothing else will dispatch while one holds the runner. A back door around
   * either is a back door around the only thing they guarantee.
   *
   * Absent means the sweep, which is the caller that must never override.
   */
  forced?: boolean
  /** The board's dispatch-relevant fingerprint right now (epic-board-fingerprint).
   *  Only meaningful while a planning generation is owed. */
  boardFingerprint: string
  /**
   * Cumulative USD across every conversation tagged with this epic, folded fresh
   * by the executor this beat from `turns.cost_usd`.
   *
   * A FLOOR ON THE TRUTH, not the truth: turns are pruned and the conversation
   * registry forgets, so this can come back SMALLER than what the run has
   * already banked. `spentSoFar` is where that is resolved, once.
   */
  spentUsd: number
  /** Now, in epoch ms. Injected because the wall-clock cap is arithmetic on the
   *  run row, and a pure decision must not read the process clock. */
  nowMs: number
}

/**
 * SCALARS THIS BEAT WANTS MERGED INTO `run.md`, BEFORE ITS ACTIONS RUN.
 *
 * THE SEAM, and it exists because of `b766b75e`: `dryGens` was read every beat
 * as the "second dry generation parks the run" valve, reported in the werk-master's
 * briefing and promised by the lease module's comment -- and nothing in the
 * engine ever incremented it. The park was unreachable for the life of the
 * feature.
 *
 * The fix that followed put the counter ON THE BEAT rather than having `planBeat`
 * write it, because planning is pure and the executor owns every write: a
 * decision and its persistence cannot then disagree about what happened. This
 * type is that arrangement generalised, so the next thing the engine needs to
 * remember per beat is a field here plus an entry in `LEDGER_KEYS` -- not a
 * second one-off `if` block bolted beside the first.
 */
export interface EpicBeatPatch {
  dryGens?: number
  spentUsd?: number
  startedAt?: string
}

/** Every field a beat may write. The prune below walks THIS, so adding a field
 *  to `EpicBeatPatch` without adding it here makes it silently un-writable. */
const LEDGER_KEYS = ['dryGens', 'spentUsd', 'startedAt'] as const

export interface EpicBeat {
  actions: EpicAction[]
  /** One line for the broker log. Never empty -- a beat that did nothing still
   *  has to say why, or a stalled epic is unexplainable from logs alone. */
  note: string
  /** What this beat wants `run.md` to say, applied BEFORE the actions. Absent
   *  when the run already says all of it -- see `pruned`. */
  patch?: EpicBeatPatch
}

const beat = (note: string, actions: EpicAction[] = [], patch?: EpicBeatPatch): EpicBeat => ({
  actions,
  note,
  ...(patch === undefined ? {} : { patch }),
})

/**
 * THE `when` AXIS, EVALUATED -- every gate this run carries, ALL of which must
 * pass on the same beat before a ready card may leave the queue.
 *
 * ONE PREDICATE AND ONE REASON STRING, which is the whole argument for putting
 * the gates on one axis instead of giving each its own verb: a run that is
 * waiting on the clock AND on another epic says both, in one line, in the one
 * place a reader already looks. This codebase's recurring failure is a run going
 * quiet with nothing saying why.
 *
 * The queue verdict is consulted regardless of what THIS run's axis says, because
 * it has two directions: a queued epic waits its turn, and every other epic waits
 * while a queued one holds the runner (`epic-queue.ts`).
 *
 * THE APPOINTMENT GATE CARRIES A COUNTDOWN ON EVERY HELD BEAT, deliberately and
 * for the same reason the restart quarantine does: a run waiting on the clock has
 * nothing in flight and nothing to show for itself, which on every other line of
 * every surface here is indistinguishable from a run that quietly died. The
 * reason string IS the countdown -- it goes to the broker log, the beat ring, and
 * from there to the wall.
 */
function whenGate(input: EpicBeatInput): { allowed: boolean; reason: string; overrode: string | null } {
  const gates = [windowGate(input), queueGate(input), appointmentGate(input), headroomGate(input)]
  const reasons = gates.flatMap(g => (g.reason ? [g.reason] : []))
  const overrides = gates.flatMap(g => (g.overrode ? [g.overrode] : []))
  return {
    allowed: reasons.length === 0,
    reason: reasons.join('; '),
    overrode: overrides.length > 0 ? overrides.join('; ') : null,
  }
}

/**
 * ONE SHAPE PER GATE: a reason that HOLDS this beat, an override that let it
 * through, or neither.
 *
 * Every gate answers in the same type even though only two of the four can ever
 * be overridden, and that uniformity is the point -- `whenGate` above became a
 * fold rather than a chain that grows an `if` per gate, and the fifth gate is a
 * function plus an array entry rather than another branch in a function that was
 * already at its complexity ceiling.
 */
type GateAnswer = { reason: string | null; overrode: string | null }

/** Project POLICY about when this box may be busy. Never overridable. */
function windowGate(input: EpicBeatInput): GateAnswer {
  const shut = gatedBy(input.run.cadence, 'window') && !input.windowOpen
  return { reason: shut ? 'when=window and the window is closed' : null, overrode: null }
}

/** A promise made to every OTHER epic: nothing else dispatches while one holds
 *  the runner. Never overridable, for that reason. */
function queueGate(input: EpicBeatInput): GateAnswer {
  if (!input.queue?.blocked) return { reason: null, overrode: null }
  return { reason: input.queue.reason ?? 'when=queue and another epic holds the runner', overrode: null }
}

/**
 * THE HEADROOM HALF -- the run may not dispatch into a fleet with no plan left.
 *
 * ON THE `when` AXIS rather than beside the caps, even though `inspect` renders
 * it as a cap, and the difference is what a beat DOES about it. Every branch of
 * `capBeat` PARKS: a spend or generation ceiling is terminal until a human raises
 * it. Headroom raises itself in twenty minutes. Parking a run because a 5h window
 * is full would need a human to un-park it for a condition that fixed itself
 * while they slept -- so it HOLDS, exactly like a closed night window, and
 * clears itself on the beat the window rolls over.
 *
 * OVERRIDABLE BY A FORCED BEAT, like the appointment and unlike `window` and
 * `queue`. A human pressing BEAT NOW against a throttled fleet is choosing to
 * spend the slot, and the run belongs to them; what they may not override are the
 * two gates that are promises made to somebody else (project policy, and every
 * other epic waiting for a quiet runner). The override is RECORDED, because a
 * dispatch that went out at 91% with no line saying why is a mystery in the
 * baton three days later.
 */
function headroomGate(input: EpicBeatInput): GateAnswer {
  if (!input.headroom?.blocked) return { reason: null, overrode: null }
  if (input.forced) return { reason: null, overrode: `${input.headroom.reason} -- OVERRIDDEN by an explicit beat` }
  return { reason: input.headroom.reason, overrode: null }
}

/**
 * THE APPOINTMENT HALF -- the only gate a forced beat may walk through.
 *
 * Its own function because it is the only one of the three with two answers
 * rather than one: a live appointment either HOLDS this beat or was OVERRIDDEN by
 * it, and both have to reach the note. Recorded rather than silent, because the
 * run then dispatches at a time its own `when` says it should not have -- and a
 * reader of the baton with no line here is looking at a gate that appears to have
 * simply failed.
 */
function appointmentGate(input: EpicBeatInput): GateAnswer {
  const waiting = whenWaitingLine(input.run.cadence, input.nowMs)
  if (!waiting) return { reason: null, overrode: null }
  if (input.forced) return { reason: null, overrode: `${waiting} -- OVERRIDDEN by an explicit beat` }
  return { reason: waiting, overrode: null }
}

/** Terminal run states do nothing at all. Checked first so an aborted run cannot
 *  be revived by a late settle arriving from a worker nobody killed in time. */
const INERT: readonly EpicRunSnapshot['status'][] = ['paused', 'complete', 'aborted']

/** Is this run one the engine should touch AT ALL? Exported because the answer
 *  has to be asked before the beat starts writing, not only when it decides --
 *  see `runEpicBeat`. */
export function isInertRun(status: EpicRunSnapshot['status']): boolean {
  return INERT.includes(status)
}

/**
 * The planning generation, in three states -- owed, in flight, settled.
 *
 * `planBaseline` is what tells them apart, and it is the fingerprint rather than
 * a flag on purpose: the same field that says "a werk-planner ran" is the evidence
 * used to decide whether it changed anything, so the two can never disagree.
 *
 * Returns null when no planning is owed, which is the common case (planning off,
 * or already done, or a run armed before this stage existed).
 */
function planningBeat(run: EpicRunSnapshot, fingerprint: string): EpicBeat | null {
  if (!run.plan || run.planned) return null

  if (!run.planBaseline) {
    return beat('generation 0: analysing the board before anything dispatches', [
      { kind: 'plan', baseline: fingerprint },
    ])
  }

  if (run.planBaseline !== fingerprint) {
    return beat('the planning generation rewrote the board; checkpointing before any work goes out', [
      { kind: 'plan-checkpoint', before: run.planBaseline, after: fingerprint },
    ])
  }

  return beat('the planning generation left the board unchanged; proceeding to the first beat', [
    { kind: 'plan-accept' },
  ])
}

/**
 * WHAT THE RUN HAS SPENT, resolved once.
 *
 * The fresh fold and the banked figure can disagree in one direction only: turns
 * are pruned on a retention window and the conversation registry forgets, so a
 * fold taken today over a week-old run comes back SMALLER than what that run
 * actually cost. Cumulative spend must never decrease -- a brake that garbage
 * collection can release is not a brake -- so the higher of the two wins, and
 * that is also the figure the cap is judged against.
 *
 * THIS IS THE DIFFERENCE FROM `dryGens`, and it is written here because the next
 * reader will otherwise "fix" it into symmetry: the dry streak counts CONSECUTIVE
 * empty generations and a productive beat clears it, while spend is cumulative
 * and no beat, however productive, may zero it.
 */
function spentSoFar(input: EpicBeatInput): number {
  return Math.max(input.run.spentUsd, input.spentUsd)
}

/**
 * THE HANDBRAKES, checked before anything else a beat could do.
 *
 * `maxGens` was the only one for the life of the feature, and it is a unit of
 * PLANNING rather than of spend: it bounds how many times the werk-master thinks
 * and bounds nothing about what the seats underneath it burn. On 2026-08-19 this
 * project billed $2,481 in one calendar day with THE WALL II running unattended,
 * and no cap of any kind was involved in stopping it.
 *
 * Order is dollars, then wall clock, then generations -- most expensive unit
 * first, so a run that is over two ceilings at once reports the one that
 * actually cost something. A ceiling of `0` is a deliberate, typed disarm; the
 * defaults are in `EPIC_RUN_DEFAULTS` and none of them is infinity.
 *
 * Every branch PARKS, which is the same terminal shape as the dry-generation
 * park: the run stops, the reason goes into the append-only baton as a
 * structured entry, and a human decides whether to raise the ceiling.
 */
function capBeat(input: EpicBeatInput): EpicBeat | null {
  const { run } = input

  const spent = spentSoFar(input)
  if (run.maxUsd > 0 && spent >= run.maxUsd) {
    return beat(`spend ceiling reached (${formatUsd(spent)}/${formatUsd(run.maxUsd)})`, [
      {
        kind: 'park',
        reason:
          `hit the spend ceiling: ${formatUsd(spent)} of ${formatUsd(run.maxUsd)} across every conversation this run ` +
          'spawned. A generation is a unit of planning, not of spend -- raise `maxUsd` and start the run ' +
          'again if this epic genuinely warrants more.',
      },
    ])
  }

  const minutes = elapsedRunMinutes(run, input.nowMs)
  if (run.maxWallClockMinutes > 0 && minutes !== null && minutes >= run.maxWallClockMinutes) {
    return beat(`wall clock ceiling reached (${minutes}/${run.maxWallClockMinutes} min)`, [
      {
        kind: 'park',
        reason:
          `hit the wall-clock ceiling of ${run.maxWallClockMinutes} minute(s): the run has been dispatching ` +
          `for ${minutes}. It has outlived the stretch it was armed for -- read the digest before resuming.`,
      },
    ])
  }

  if (input.gen >= run.maxGens) {
    return beat(`generation ceiling reached (${input.gen}/${run.maxGens})`, [
      { kind: 'park', reason: `hit the generation ceiling of ${run.maxGens} -- the run is thrashing, not working` },
    ])
  }

  return null
}

/**
 * HOW LONG THE CURRENT LEASE HAS BEEN HELD, or null when that cannot be known.
 *
 * NULL IS "DO NOT BREAK IT", and it is the OPPOSITE reading `isStale`
 * (epic-lease.ts) gives the same missing timestamp. The asymmetry is deliberate,
 * because the two are answering different questions: the CAS asks "may this
 * waker take the grip", which a released or never-stamped lease should not
 * block, while this asks "may the engine dispatch underneath a live supervisor",
 * which on no evidence at all it should not.
 */
function leaseHeldMs(input: EpicBeatInput): number | null {
  if (!input.leaseAt) return null
  const taken = Date.parse(input.leaseAt)
  return Number.isFinite(taken) ? Math.max(0, input.nowMs - taken) : null
}

/** The werk-master gate's two outcomes, and never both: HOLD this beat, or say out
 *  loud that the grip has aged out and go on without it. */
interface WerkMasterVerdict {
  /** The beat to return, when a live supervisor still owns the epic. */
  hold: EpicBeat | null
  /** The grip is past its TTL. Rides on whatever note this beat ends up writing,
   *  because a beat emits exactly ONE line and the useful shape is "here is the
   *  hold I did not take, and here is what I did instead". */
  aged: string | null
}

/**
 * IS A LIVE WERK-MASTER STILL ENTITLED TO THE WHOLE RUN? Bare liveness used to be
 * the entire answer, and that single unconditional early return was the deadlock
 * of 2026-08-20.
 *
 * A werk-master mid-turn owns the epic and nothing may dispatch underneath it: it
 * may be rewriting the very cards the plan was computed from. The WERK-PLANNER sits in
 * the same seat, so this covers it too -- which is most of why it is not a
 * separate role. But `werkMasterAlive` has no upper bound, and the one shape that
 * breaks the engine is invisible from outside: a blocking Bash call (`until ...
 * sleep`) emits no events AND keeps its agent-host socket, so the conversation
 * scores `idle`, `seatAbandoned` cannot reap it (it requires NO socket), and the
 * hold below never lifts. Gen 14 of `epic-the-wall-ii` logged `werk-master alive at
 * gen 14; holding the beat` 13+ consecutive times with three cards ready and zero
 * in flight, and only a human with a `kill` got the run moving again.
 *
 * SO THE GRIP HAS AN AGE, AND IT IS `LEASE_STALE_MS` -- the SAME constant
 * `evaluateLease` has always presumed a holder dead at, imported rather than
 * re-chosen. Nothing here decides staleness for the fleet; it puts to the beat a
 * question the CAS was already answering and was never asked. Sizing this
 * shorter would be strictly worse than the deadlock it replaces: the beat would
 * send a wake the CAS then refuses, every 45 seconds, which is the same freeze
 * with a busier log.
 *
 * WHAT HAPPENS AFTER IT LIFTS is the existing engine and nothing new. Ready cards
 * dispatch; a run with nothing ready reaches `wake-werk-master`, whose CAS grants
 * over the aged holder (`holderAlive && !isStale` is false) and records it in
 * `replaced`, so the displacement is audited rather than lost. The replacement's
 * lease is stamped fresh, so a supervisor that stays wedged costs ONE extra
 * generation per TTL window -- bounded by `maxGens`, loud in the baton, and not a
 * stopped run.
 */
function werkMasterGate(input: EpicBeatInput): WerkMasterVerdict {
  if (!input.werkMasterAlive) return { hold: null, aged: null }

  const heldMs = leaseHeldMs(input)
  const age = heldMs === null ? 'lease age unknown' : `lease taken ${formatDuration(heldMs)} ago`

  // Strictly greater, matching `isStale`. Equality holding is what keeps the two
  // from disagreeing for one tick at the boundary.
  if (heldMs === null || heldMs <= LEASE_STALE_MS) {
    return { hold: beat(`werk-master alive at gen ${input.gen} and WORKING (${age}); holding the beat`), aged: null }
  }

  return {
    hold: null,
    // "NOT holding" rather than "breaking it": this beat lets go of the HOLD, and
    // whether the lease itself moves depends on whether what follows is a wake.
    // A dispatch under an aged grip touches no lease at all.
    aged:
      `werk-master alive at gen ${input.gen} but its lease is STALE (${age}, TTL ` +
      `${formatDuration(LEASE_STALE_MS)}) -- NOT holding the beat`,
  }
}

/**
 * THE DECISION, with the two gates that outrank every other reason a beat has.
 *
 * Ordering, and it is the design rather than an accident of layout: the CEILINGS
 * come first, so a run that is over budget parks whatever the lease says and its
 * park note does not claim a grip was let go. The WERK-MASTER GATE comes second,
 * because everything below it either dispatches work or wakes a supervisor, and
 * both are things a live werk-master is entitled to stop.
 *
 * Split from `guardBeat` so the aged-lease line can ride onto the note of
 * whatever the beat went on to do -- including `workBeat`'s, which `guardBeat`
 * never sees.
 */
function decide(input: EpicBeatInput): EpicBeat {
  const capped = capBeat(input)
  if (capped) return capped

  const werkMaster = werkMasterGate(input)
  if (werkMaster.hold) return werkMaster.hold

  const decided = guardBeat(input) ?? workBeat(input)
  return werkMaster.aged ? { ...decided, note: `${werkMaster.aged}; ${decided.note}` } : decided
}

/**
 * Reasons a beat does something OTHER than move work, most urgent first. Order
 * is the design: an epic that is simultaneously owed a plan and holding an
 * unacknowledged settle must do exactly one of those, and which one is not
 * arbitrary. The two gates ABOVE all of these live in `decide`.
 *
 * Returns null when nothing is in the way, at which point `workBeat` decides.
 */
function guardBeat(input: EpicBeatInput): EpicBeat | null {
  const { plan } = input

  // GENERATION 0. Ahead of every other decision, including settles and questions:
  // once planning is owed, nothing may dispatch until it has happened, or the
  // engine would race the pass that exists to tell it what may run in parallel.
  //
  // AHEAD OF THE REAP BELOW, TOO, and deliberately: the werk-planner sits in the
  // werk-master seat, so a werk-planner that died silently is reaped here like any other
  // supervisor -- but what that run owes is a resolved planning generation, not a
  // second werk-planner. `planningBeat` accepts or checkpoints from the FINGERPRINT,
  // which is a fact about the board rather than about the conversation, and is
  // therefore the right answer whether the werk-planner exited or died. Waking a
  // replacement first would spawn a plain werk-master into a run that still has
  // `planned: false`, and the next beat would come straight back here.
  const planning = planningBeat(input.run, input.boardFingerprint)
  if (planning) return planning

  // THE SUPERVISOR DIED WITHOUT SAYING SO. Ahead of the settle branch below, and
  // the ordering is the only thing at stake: both wake exactly one werk-master and
  // both hand it the same settled list (the executor passes `pending` whichever
  // branch fired), so what the order decides is WHICH FACT THE GENERATION IS
  // NAMED AFTER. A generation that replaced a corpse is not the same event as one
  // that followed a finished turn, and until this branch existed the two were
  // indistinguishable on every surface that renders either.
  if (input.werkMasterLost) {
    const also = input.unacknowledged.length > 0 ? `; ${input.unacknowledged.length} unacknowledged settle(s)` : ''
    return beat(`werk-master seat REAPED at gen ${input.gen}; waking a replacement${also}`, [
      { kind: 'wake-werk-master', expectGen: input.gen, reason: 'werk-master-lost' },
    ])
  }

  // A settled card the baton has not seen is the ONE fact that must reach a
  // fresh werk-master, and it outranks dispatching more work.
  if (input.unacknowledged.length > 0) {
    return beat(`${input.unacknowledged.length} unacknowledged settle(s): ${input.unacknowledged.join(', ')}`, [
      { kind: 'wake-werk-master', expectGen: input.gen, reason: 'card-settled' },
    ])
  }

  // A question only the werk-master can answer, and no werk-master running.
  if (plan.questions.length > 0) {
    return beat(`${plan.questions.length} open question(s) for the werk-master`, [
      { kind: 'wake-werk-master', expectGen: input.gen, reason: 'started' },
    ])
  }

  return null
}

/**
 * What this beat wants written down REGARDLESS of what it decided to do.
 *
 * Spend is folded every beat, and the wall clock starts on the first beat the
 * run is actually permitted to dispatch -- not when it was armed. A `window`
 * run armed at noon may not dispatch until the night window opens, and a clock
 * started at arming would spend that whole wait burning a budget the run was
 * never allowed to use.
 */
function ledgerWrites(input: EpicBeatInput): EpicBeatPatch {
  const clockStarted = Boolean(input.run.startedAt)
  // THE SAME PREDICATE THE DISPATCH USES, and that identity is what makes
  // `startedAt` mean "permitted to dispatch" for the queue gate as well as for
  // the window one. It is also what `epic-queue.ts` reads back as "this queued
  // run has ENTERED and now holds the runner" -- so a second stamp for the queue
  // would be a second answer to a question this one already answers.
  const mayWork = whenGate(input).allowed
  return {
    spentUsd: spentSoFar(input),
    ...(clockStarted || !mayWork ? {} : { startedAt: new Date(input.nowMs).toISOString() }),
  }
}

/**
 * Drop every field the run already says, so a beat states what it WANTS `run.md`
 * to read and never has to remember what it already reads. One rule in one
 * place: without it each new counter grows its own `!== run.x` test at its own
 * call site, and the one that gets the test wrong is unwritable in silence --
 * which is exactly how `dryGens` spent a whole feature stuck at zero.
 */
function pruned(patch: EpicBeatPatch, run: EpicRunSnapshot): EpicBeatPatch | undefined {
  const out: Record<string, unknown> = {}
  for (const key of LEDGER_KEYS) {
    const wanted = patch[key]
    if (wanted !== undefined && wanted !== run[key]) out[key] = wanted
  }
  return Object.keys(out).length > 0 ? (out as EpicBeatPatch) : undefined
}

export function planBeat(input: EpicBeatInput): EpicBeat {
  // A TERMINAL RUN IS TOUCHED BY NOTHING -- no action AND no write. Checked here
  // rather than inside `guardBeat` because the ledger below writes on every
  // other path, and a paused run appending a spend patch every 45 seconds is the
  // same class of bug as the baton entries a paused epic used to collect.
  if (isInertRun(input.run.status)) return beat(`run is ${input.run.status}; nothing to do`)

  const decided = decide(input)
  // The decision's own writes win over the ledger's: they are about THIS beat,
  // and the ledger is about the run.
  const patch = pruned({ ...ledgerWrites(input), ...decided.patch }, input.run)
  return patch ? { ...decided, patch } : { actions: decided.actions, note: decided.note }
}

/**
 * Nothing is in the way: move the work, or explain why there is none.
 *
 * The suppression below is on CRAP only, and it is measured rather than waved
 * through: cyclomatic and cognitive are both 10, under their thresholds, and the
 * CRAP score is `CC^2 * (1 - cov)^3 + CC` against an ESTIMATED coverage --
 * fallow infers it from export references, and this function is deliberately not
 * exported. Real coverage from `bun test --coverage` on epic-beat.test.ts is
 * 100% of lines and 8/8 functions in this file, which puts actual CRAP at 10.
 */
function workBeat(input: EpicBeatInput): EpicBeat {
  const { plan } = input
  const actions: EpicAction[] = plan.verify.map(c => ({ kind: 'verify' as const, cardId: c.slug }))

  // THE GATE HOLDS DISPATCH ONLY, never verification -- the `verify` actions are
  // already in `actions` above and go out regardless. A verdict is closing out
  // work that already happened, and a gate that froze it too would deadlock the
  // queue: the scope holding the runner could never drain, so the one waiting for
  // a quiet runner could never enter.
  const gate = whenGate(input)
  if (!gate.allowed) {
    return beat(`${gate.reason}; ${plan.dispatch.length} card(s) waiting`, actions)
  }

  const decided = movedBeat(input, actions)
  // The override rides on whatever this beat went on to say, rather than being a
  // note of its own: a beat emits exactly ONE line, and the useful shape is
  // "here is the gate I walked through, and here is what I did with it". Applied
  // to every outcome and not just the dispatching one, because a forced beat that
  // fired an appointment early and then found nothing to do is the case a reader
  // most needs explaining.
  return gate.overrode ? { ...decided, note: `${gate.overrode}; ${decided.note}` } : decided
}

/**
 * Every gate passed: move the work, or explain why there is none.
 *
 * The suppression below is on CRAP only, and it is measured rather than waved
 * through: cyclomatic and cognitive are both under their thresholds, and the CRAP
 * score is `CC^2 * (1 - cov)^3 + CC` against an ESTIMATED coverage -- fallow
 * infers it from export references, and this function is deliberately not
 * exported. Real coverage from `bun test --coverage` on epic-beat.test.ts is
 * 100% of lines in this file.
 */
// fallow-ignore-next-line complexity
function movedBeat(input: EpicBeatInput, actions: EpicAction[]): EpicBeat {
  const { run, plan } = input

  actions.push(...plan.dispatch.map(c => ({ kind: 'dispatch' as const, cardId: c.slug, dependsOn: c.dependsOn ?? [] })))

  if (actions.length > 0) {
    return beat(
      `dispatching ${plan.dispatch.length}, verifying ${plan.verify.length}` +
        // THE HELD-BACK LINE NAMES WHO IS HOLDING THE SLOTS. It was a bare count,
        // and a bare count is unfalsifiable: `epic-project-runner` gen 7 read
        // "held back by the concurrency ceiling" for twelve minutes while one of
        // the two slots belonged to a conversation that had been dead the whole
        // time, and there was nothing in the sentence for a reader to check.
        (plan.heldBack.length > 0
          ? ` (${plan.heldBack.length} held back by the concurrency ceiling, held by: ${input.inFlight.join(', ')})`
          : ''),
      actions,
      // Work moved, so the dry streak is over. CONSECUTIVE is the whole point:
      // a run that alternates between a dry generation and a real one is making
      // progress, and must never accumulate its way into a park. (Stated
      // unconditionally -- `pruned` drops it when the counter is already 0.)
      { dryGens: 0 },
    )
  }

  if (plan.complete) return beat('every child terminal', [{ kind: 'complete' }])

  // NAMED, for the reason above -- and this is the line the leaked slot actually
  // produced, since a run with nothing else ready never reaches the held-back
  // wording at all.
  if (input.inFlight.length > 0) {
    return beat(`${input.inFlight.length} still in flight; waiting: ${input.inFlight.join(', ')}`)
  }

  // Nothing to do and nothing running. The werk-master gets ONE chance to replan
  // before the run parks -- most "stuck" epics are a board problem it can fix.
  if (run.dryGens >= 1) {
    return beat(`second consecutive dry generation: ${plan.idleReason ?? 'nothing dispatchable'}`, [
      { kind: 'park', reason: plan.idleReason ?? 'nothing dispatchable and replanning did not help' },
    ])
  }

  // A DRY generation: nothing to dispatch, nothing running, so the werk-master gets
  // one chance to replan. Counting it is what makes the park above reachable --
  // without the increment this branch is an infinite loop that bills a fresh
  // werk-master every 45s and calls it healthy.
  return beat(
    `nothing dispatchable (${plan.idleReason ?? 'unknown'}); waking the werk-master to replan ` +
      `(dry generation ${run.dryGens + 1})`,
    [{ kind: 'wake-werk-master', expectGen: input.gen, reason: 'started' }],
    { dryGens: run.dryGens + 1 },
  )
}
