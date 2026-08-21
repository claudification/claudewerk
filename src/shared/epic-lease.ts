/**
 * THE OVERSEER LEASE -- "there can only be one", as a compare-and-swap.
 *
 * Two implementers finishing within the same 45s guardian sweep is the NORMAL
 * case, not the edge case, and the naive handler spawns two overseers that both
 * read the same board, both dispatch the same ready card, and both write the
 * baton. So the wake is a CAS: a waker states the generation it believes is
 * current, and exactly one of them is right.
 *
 * The lease lives on the EPIC CARD's frontmatter rather than in the run file,
 * and that is deliberate -- a stuck run should be visible and breakable by a
 * human reading the board, not require knowing that `.rclaude/project/epics/`
 * exists. `overseer_at` is there so a human can see how long it has been stuck.
 *
 * ONE LEASE, TWO SCOPES. `evaluateLease` decides an EPIC's overseer singleton and
 * a CARD's per-role seat singleton (epic-seat-lease.ts), because they are the
 * same question at different scope: may this conversation write here, given who
 * holds it, whether that holder is alive, and how long it has held. The only
 * thing that differs is WHICH FRONTMATTER KEYS carry the grip -- so that, and
 * only that, is what `keyPrefix` parameterises. A second implementation would
 * drift, and the one that drifted would be the one nobody re-argued.
 *
 * Pure. Liveness is the caller's to know (the broker owns the conversation
 * registry); this module only decides what that fact means.
 */

import { nowIso } from './epic-paths'

export interface EpicLease {
  /** Conversation currently holding the epic. */
  convId: string
  /** Generation that conversation is serving. */
  gen: number
  /** ISO time the lease was taken. */
  at: string
}

export interface LeaseRequest {
  /** The conversation about to become the overseer. */
  convId: string
  /** The generation the waker believes is current. The CAS check. */
  expectGen: number
  /** Is the current holder's conversation still alive? Caller's knowledge. */
  holderAlive: boolean
  /** A human breaking a stuck lease. Skips the liveness and CAS checks, never
   *  the audit -- the displaced lease comes back in `replaced`. */
  force?: boolean
  /**
   * SWAP THE REAL CONVERSATION ID IN, same generation.
   *
   * A wake must take the lease BEFORE it knows its conversation id -- the CAS is
   * what decides whether it may spawn at all -- so it takes it under a `pending-`
   * placeholder and adopts once the spawn returns. Adoption is not a wake: it
   * burns no generation and keeps the original take time, so the stale window
   * still measures how long the WAKE has been sitting.
   *
   * Without it the board carries a holder no lookup can resolve, which is worse
   * than an empty lease -- the panel shows no overseer, and every check written
   * as "is the holder alive" silently answers no.
   */
  adopt?: boolean
}

export type LeaseDecision =
  | { grant: true; lease: EpicLease; replaced?: EpicLease }
  | { grant: false; reason: string; holder: EpicLease }

/** A holder this old with no live conversation is presumed dead even if the
 *  caller could not determine liveness. Ten minutes is far longer than a boot. */
export const LEASE_STALE_MS = 10 * 60 * 1000

/**
 * THE DEFAULT SCOPE -- the epic's overseer singleton, on the epic card. Keys
 * `overseer`, `overseer_gen`, `overseer_at`. A seat lease passes its own prefix
 * (`seatLeaseKeyPrefix`), and nothing else about the three functions changes.
 */
export const OVERSEER_KEY_PREFIX = 'overseer'

/**
 * Read a lease out of card frontmatter. `null` means the epic has NEVER been
 * run; a lease with an empty `convId` means it ran and released, which is a
 * different fact -- the generation counter must survive a release or the next
 * wake would reuse a generation number that is already in the baton.
 */
export function readLease(meta: Record<string, unknown>, keyPrefix = OVERSEER_KEY_PREFIX): EpicLease | null {
  const convId = typeof meta[keyPrefix] === 'string' ? (meta[keyPrefix] as string) : ''
  const rawGen = meta[`${keyPrefix}_gen`]
  const gen = typeof rawGen === 'number' ? rawGen : Number.parseInt(String(rawGen ?? ''), 10)
  const hasGen = Number.isFinite(gen)
  if (!convId && !hasGen) return null
  const at = meta[`${keyPrefix}_at`]
  return {
    convId,
    gen: hasGen ? gen : 0,
    at: typeof at === 'string' ? at : '',
  }
}

/** The frontmatter patch that records a lease. */
export function leasePatch(lease: EpicLease, keyPrefix = OVERSEER_KEY_PREFIX): Record<string, unknown> {
  return { [keyPrefix]: lease.convId, [`${keyPrefix}_gen`]: lease.gen, [`${keyPrefix}_at`]: lease.at }
}

/**
 * The frontmatter patch that releases one. `<prefix>_gen` is deliberately NOT
 * cleared: it is the run's generation counter, not part of the grip, and reusing
 * a generation number would put two different beats in the baton under one id.
 */
export function releasePatch(keyPrefix = OVERSEER_KEY_PREFIX): Record<string, unknown> {
  return { [keyPrefix]: '', [`${keyPrefix}_at`]: '' }
}

/** The holder reported when there is none -- a refusal still owes the caller a
 *  shape it can read without a null check. */
const EMPTY_LEASE: EpicLease = { convId: '', gen: 0, at: '' }

function isStale(lease: EpicLease, nowMs: number): boolean {
  if (!lease.at) return true
  const taken = Date.parse(lease.at)
  return !Number.isFinite(taken) || nowMs - taken > LEASE_STALE_MS
}

/**
 * Decide one wake. The granted lease always advances the generation by exactly
 * one, so `gen` doubles as a wake counter -- if it climbs without the board
 * moving, the run is thrashing and `dryGens` will park it.
 */
export function evaluateLease(current: EpicLease | null, req: LeaseRequest, nowMs: number): LeaseDecision {
  const next = (fromGen: number): EpicLease => ({ convId: req.convId, gen: fromGen + 1, at: nowIso(nowMs) })

  // Never run: the first generation is 1, whatever the waker guessed.
  if (!current) {
    if (req.adopt) return { grant: false, reason: 'nothing to adopt: the lease was never taken', holder: EMPTY_LEASE }
    return { grant: true, lease: { convId: req.convId, gen: 1, at: nowIso(nowMs) } }
  }

  if (req.force) return { grant: true, lease: next(current.gen), replaced: current }

  // Adoption is the SAME grip under its real name, so it is checked against the
  // generation it is adopting and never advances one.
  if (req.adopt) {
    if (current.gen !== req.expectGen) {
      return {
        grant: false,
        reason: `stale adopt: expected gen ${req.expectGen}, epic is at gen ${current.gen}`,
        holder: current,
      }
    }
    return { grant: true, lease: { convId: req.convId, gen: current.gen, at: current.at }, replaced: current }
  }

  // Someone else already woke on the same fact. Exactly one waker sees a match.
  if (current.gen !== req.expectGen) {
    return {
      grant: false,
      reason: `stale wake: expected gen ${req.expectGen}, epic is at gen ${current.gen}`,
      holder: current,
    }
  }

  // Ran and released. Nobody holds it, so liveness is not a question.
  if (!current.convId) return { grant: true, lease: next(current.gen) }

  if (req.holderAlive && !isStale(current, nowMs)) {
    return {
      grant: false,
      reason: `overseer ${current.convId.slice(0, 8)} is alive at gen ${current.gen}`,
      holder: current,
    }
  }

  return { grant: true, lease: next(current.gen), replaced: current }
}
