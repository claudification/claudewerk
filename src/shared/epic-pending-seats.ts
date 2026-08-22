/**
 * THE WINDOW BETWEEN "A SEAT WAS DISPATCHED" AND "THE REGISTRY KNOWS IT EXISTS".
 *
 * ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓
 * ┃  A CARD WHOSE SEAT HAS NOT ATTACHED YET IS NOT A CARD NOBODY IS WORKING.  ┃
 * ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛
 *
 * `EpicGroup` is folded purely from the conversation registry, and a spawned
 * conversation carries no epic tag until its agent host connects
 * (`setPendingLaunchConfig` is consumed by the meta handler). So between the beat
 * that spawns a seat and the beat that can first see it, the card sits in NO
 * lane -- not `inFlight`, not `inVerify`, not `settled` -- and the next beat,
 * computing both liveness sets from an empty answer, sends another seat.
 *
 * WHAT THAT COSTS, measured 2026-08-21 on `epic-project-runner` itself: four of
 * six live seats were duplicates, in BOTH lanes at once, six minutes apart. Two
 * werk-workers on one card get the SAME worktree, because the worktree name is
 * derived from the card (`cardBranch`). Git sees one working directory, so
 * whichever seat commits last stages the other's half-written files as its own.
 * No conflict, no failed merge, no signal -- the loser's work is buried inside a
 * commit that claims to be somebody else's.
 *
 * `MAX_CARD_SEATS` already bounds this window's COST and that remains right for
 * what it was built for: seats that die producing nothing. It is the wrong
 * instrument here, because the cost of this window is not a wasted seat, it is
 * six writers in one directory. A bound of six on that is not a mitigation.
 *
 * WHY THE BATON AND NOT A BROKER-SIDE MAP. `spawnForCard` appends its `dispatch`
 * entry the instant a spawn is accepted, with the conversation id it was handed.
 * That is a durable, append-only, on-disk record of "a seat went out, and which
 * one" -- so this survives a broker restart, needs no eviction wiring, and cannot
 * drift from what the run's own log says happened. An in-memory pending map would
 * be a second source of truth for the same fact, and would forget it in exactly
 * the restart the engine is least able to reason about.
 *
 * EVICTION IS BY EVIDENCE, NOT BY THE CLOCK -- and that ordering is the whole
 * reason this is not just a cooldown. `EpicGroup.convIds` is every conversation
 * this epic has ever had in the registry, live or dead, every role. The moment
 * the dispatched conversation appears there, the registry has caught up and the
 * claim is dropped on the spot. So a fast seat costs no delay at all, and the
 * grace below is only ever paid by a launch that has not landed yet.
 *
 * THE GRACE IS A CEILING ON BEING WRONG, in the safe direction. A spawn that
 * never connects would otherwise withhold its card forever -- the wedge failure,
 * strictly worse than the duplicate. After the grace the card is dispatchable
 * again and the two ceilings built for that case take over: `MAX_LAUNCH_ATTEMPTS`
 * (via `EpicGroup.unspawnable`) and `MAX_CARD_SEATS`.
 *
 * ROLE-BLIND, like `dispatchCountsByCard` and for the same reason: nothing in a
 * `dispatch` entry distinguishes a werk-worker from a werk-verifier. The result is
 * unioned into BOTH lanes, which is the conservative direction -- and the live
 * incident proves both lanes need it, since the werk-verifier pair collided while
 * `inVerify` was working exactly as designed.
 */

import type { EpicLogEntry } from './epic-run-types'

/**
 * How long a dispatched-but-unattached seat holds its card.
 *
 * FIVE MINUTES, matching `pendingLaunchConfigs`' own TTL in
 * `conversation-store.ts` -- the broker already treats five minutes as the
 * outside edge of "this spawn is still arriving", and a second, different answer
 * to the same question is how the two drift apart. Normal attach is seconds; this
 * is sized for a sentinel mid-restart, not for a healthy launch.
 */
export const SEAT_ATTACH_GRACE_MS = 5 * 60 * 1000

/**
 * Entries that say a seat CAME BACK, so its card is no longer arriving.
 *
 * The same pair `acknowledgedCardIds` treats as outcomes, and deliberately so --
 * one definition of "this card got an answer" or the two drift. Note the known
 * asymmetry: `appendEpicLog` writes at most one machine `completion` per card by
 * design, so a card that settles a SECOND time never gets a second resolving
 * entry. That direction is safe -- the later seat simply holds its card until the
 * grace expires instead of being released early.
 */
const RESOLVING_KINDS: ReadonlySet<EpicLogEntry['kind']> = new Set(['completion', 'verdict'])

export interface PendingSeatInput {
  /** The WHOLE baton, not the prompt-sized tail. */
  baton: readonly EpicLogEntry[]
  /** `EpicGroup.convIds` -- every conversation the registry has for this epic. */
  knownConvIds: readonly string[]
  nowMs: number
  graceMs?: number
}

/**
 * Card ids with a seat dispatched recently enough that its silence means
 * "still arriving" rather than "nobody is working this".
 *
 * An entry with an unparsable `ts` is SKIPPED rather than treated as fresh. The
 * claim this function makes is "a seat went out RECENTLY", and an entry that
 * cannot say when is an entry that cannot support it -- inventing a timestamp to
 * fill the gap is how a card gets withheld on no evidence at all. A clock that
 * runs backwards is the opposite case and does count: an entry stamped in the
 * future is a seat that certainly has not attached yet.
 */
export function pendingSeatCards(input: PendingSeatInput): string[] {
  const grace = input.graceMs ?? SEAT_ATTACH_GRACE_MS
  const known = new Set(input.knownConvIds)
  const cards = new Set<string>()
  for (const e of input.baton) {
    // A RESOLVING ENTRY CLEARS THE CARD, and reading the log in order is the
    // whole of it: a `completion` or `verdict` written AFTER a dispatch says
    // that seat came back, so nothing is arriving any more. A resolving entry
    // BEFORE the dispatch says nothing about it, which is why this cannot be a
    // set membership test -- a bounced card's new seat must still be held.
    if (RESOLVING_KINDS.has(e.kind) && e.cardId) {
      cards.delete(e.cardId)
      continue
    }
    if (e.kind !== 'dispatch' || !e.cardId || !e.convId) continue
    if (known.has(e.convId)) continue
    const at = Date.parse(e.ts)
    if (Number.isNaN(at)) continue
    if (input.nowMs - at < grace) cards.add(e.cardId)
  }
  return [...cards].sort()
}

/** Union a lane with the pending cards, order-stable so a log line reads the
 *  same twice. Both lanes get the same treatment, hence one helper. */
export function withPendingSeats(lane: readonly string[], pending: readonly string[]): string[] {
  return [...new Set([...lane, ...pending])].sort()
}
