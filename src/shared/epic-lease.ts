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
}

export type LeaseDecision =
  | { grant: true; lease: EpicLease; replaced?: EpicLease }
  | { grant: false; reason: string; holder: EpicLease }

/** A holder this old with no live conversation is presumed dead even if the
 *  caller could not determine liveness. Ten minutes is far longer than a boot. */
export const LEASE_STALE_MS = 10 * 60 * 1000

/**
 * Read a lease out of card frontmatter. `null` means the epic has NEVER been
 * run; a lease with an empty `convId` means it ran and released, which is a
 * different fact -- the generation counter must survive a release or the next
 * wake would reuse a generation number that is already in the baton.
 */
export function readLease(meta: Record<string, unknown>): EpicLease | null {
  const convId = typeof meta.overseer === 'string' ? meta.overseer : ''
  const rawGen = meta.overseer_gen
  const gen = typeof rawGen === 'number' ? rawGen : Number.parseInt(String(rawGen ?? ''), 10)
  const hasGen = Number.isFinite(gen)
  if (!convId && !hasGen) return null
  return {
    convId,
    gen: hasGen ? gen : 0,
    at: typeof meta.overseer_at === 'string' ? meta.overseer_at : '',
  }
}

/** The frontmatter patch that records a lease. */
export function leasePatch(lease: EpicLease): Record<string, unknown> {
  return { overseer: lease.convId, overseer_gen: lease.gen, overseer_at: lease.at }
}

/**
 * The frontmatter patch that releases one. `overseer_gen` is deliberately NOT
 * cleared: it is the run's generation counter, not part of the grip, and reusing
 * a generation number would put two different beats in the baton under one id.
 */
export function releasePatch(): Record<string, unknown> {
  return { overseer: '', overseer_at: '' }
}

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
  if (!current) return { grant: true, lease: { convId: req.convId, gen: 1, at: nowIso(nowMs) } }

  if (req.force) return { grant: true, lease: next(current.gen), replaced: current }

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
