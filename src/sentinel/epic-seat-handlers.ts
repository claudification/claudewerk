/**
 * Sentinel handlers for the PER-CARD SEAT LEASE (epic-seat-lease.ts).
 *
 * Three ops, and the only interesting one is `seat_claim`. It is the same CAS
 * the werk-master lease uses -- `evaluateLease`, unchanged -- pointed at a
 * different set of frontmatter keys on a different card, and it carries the same
 * hard requirement: NO AWAIT between the read and the write, or two seats
 * connecting in the same second would both read "free" and both grant. Node's
 * single-threaded synchronous fs is what makes that safe; if this ever moves off
 * it, this is the code that breaks.
 *
 * Separate file from `epic-handlers.ts` so that file stays the epic-scoped op
 * map. These three are card-scoped and share none of its helpers.
 */

import { readLease, releasePatch } from '../shared/epic-lease'
import { safeCardId } from '../shared/epic-paths'
import { seatLeaseKeyPrefix } from '../shared/epic-seat-lease'
import type { EpicOp, EpicResult, EpicSeatInput } from '../shared/protocol'
import { casLeaseOnCard, patchCardMeta, readCardMeta } from './epic-card-meta'

type OpOutcome = Omit<EpicResult, 'type' | 'requestId' | 'op'>
type SeatHandler = (root: string, msg: EpicOp, nowMs: number) => OpOutcome

const fail = (error: string): OpOutcome => ({ ok: false, error })

/** Everything all three ops need: a validated payload, the card's frontmatter,
 *  and the key prefix the role writes under. */
interface SeatContext {
  seat: EpicSeatInput
  meta: Record<string, unknown>
  prefix: string
}

/**
 * Validate, resolve, read. Returns the ERROR TEXT rather than throwing, so every
 * op answers instead of leaving the broker waiting for a reply that never comes.
 *
 * `needsConvId` because `seat_get` is the one op with no claimant: it is the
 * question the broker asks BEFORE it has decided who is asking.
 */
function seatContext(root: string, msg: EpicOp, needsConvId: boolean): SeatContext | string {
  const seat = msg.seat
  if (!seat?.cardId) return 'seat.cardId required'
  if (!seat.role) return 'seat.role required'
  if (needsConvId && !seat.convId) return 'seat.convId required'
  try {
    safeCardId(seat.cardId)
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
  const meta = readCardMeta(root, seat.cardId)
  if (!meta) return `card not found: ${seat.cardId}`
  return { seat, meta, prefix: seatLeaseKeyPrefix(seat.role) }
}

export const SEAT_HANDLERS: Record<string, SeatHandler> = {
  /**
   * WHO HOLDS THIS SEAT. The broker's first hop: it must know the holder before
   * it can answer `holderAlive`, and it must know the generation before it can
   * state one in the CAS. `null` means nobody has ever claimed this seat.
   */
  seat_get(root, msg) {
    const ctx = seatContext(root, msg, false)
    if (typeof ctx === 'string') return fail(ctx)
    return { ok: true, currentLease: readLease(ctx.meta, ctx.prefix) }
  },

  /**
   * THE CLAIM. Every refusal path lives inside `evaluateLease` and there is NO
   * EARLY RETURN ABOVE THE CAS -- that is deliberate and it is the whole of
   * Done-when 4. The werk-master beat's own deadlock on 2026-08-20 was not a
   * missing TTL: the TTL existed and worked, and `epic-beat.ts:251` returned
   * "werk-master alive; holding the beat" above the CAS so the question was never
   * put. A wedged holder is displaced here because the CAS is REACHED.
   */
  seat_claim(root, msg, nowMs) {
    const ctx = seatContext(root, msg, true)
    if (typeof ctx === 'string') return fail(ctx)
    const { seat, meta, prefix } = ctx
    const req = {
      convId: seat.convId as string,
      expectGen: seat.expectGen ?? 0,
      holderAlive: seat.holderAlive ?? false,
    }
    return { ok: true, lease: casLeaseOnCard(root, seat.cardId, prefix, meta, req, nowMs) }
  },

  /**
   * THE RELEASE, and it REFUSES A NON-HOLDER.
   *
   * The werk-master's `release` is unguarded because only the broker ever sends it.
   * This one is sent by the SEAT, and the seat that most wants to send it is the
   * one that just lost -- a losing claimant that could release would hand the
   * card to nobody while the winner is mid-edit, which is the corruption this
   * lease exists to prevent, arrived by the front door.
   *
   * A release of a seat nobody holds is a no-op success, not an error: a seat
   * whose lease was already broken by a later claimant must still be able to
   * finish tidying up without its exit path failing.
   */
  seat_release(root, msg) {
    const ctx = seatContext(root, msg, true)
    if (typeof ctx === 'string') return fail(ctx)
    const { seat, meta, prefix } = ctx

    const held = readLease(meta, prefix)
    if (!held?.convId) return { ok: true, currentLease: held }
    if (held.convId !== seat.convId) {
      return fail(`seat held by ${held.convId}, not ${seat.convId} -- only the holder may release it`)
    }
    patchCardMeta(root, seat.cardId, releasePatch(prefix))
    return { ok: true, currentLease: readLease(readCardMeta(root, seat.cardId) ?? {}, prefix) }
  },
}
