/**
 * SEAT RESERVATIONS -- who may take one of the scheduler's three slots.
 *
 * `MAX_CONCURRENT_SCHEDULED_SPAWNS` (policy.ts) is a GLOBAL ceiling: at most 3
 * scheduler-originated spawns in flight, whoever asks. That is enough to stop
 * the scheduler eating the machine and not enough to stop ONE role eating the
 * scheduler. Forty `#needs-refine` cards and a `REFINER@1` schedule will hold
 * all three slots for as long as the backlog lasts, and the nightly board sweep
 * -- which fires once, at a fixed minute, and does not retry -- simply never
 * runs. It does not fail; it is skipped, and the skip looks like every other
 * overlap skip in the history.
 *
 * A RESERVATION is a per-order share of that pool: an order declaring
 * `reservation: 1` may hold at most one of the three, so two remain reachable by
 * everything else no matter how deep its own queue is. The reservation lives on
 * the ORDER (`SeatOrder.reservation`), not on the schedule and not here -- a
 * role's appetite is a property of the role, and putting it here would mean the
 * broker deciding again what each seat is, which is what `order@1` exists to
 * stop.
 *
 * The decision is a pure function so the interesting case -- four refiners due
 * in the same minute -- is a table, not a race.
 */

import type { SeatOrder } from '../../shared/refiner-order'

/**
 * Scheduler spawns in flight right now, total and for one order.
 *
 * NEITHER COUNT INCLUDES THE FIRE BEING DECIDED -- a slot is claimed only when
 * a dispatch actually starts, so a fire that is refused here costs nothing.
 *
 * That is a change, and it fixes an off-by-one. The census used to be the
 * engine's `firing` set, which is the DOUBLE-FIRE guard: a schedule enters it
 * the moment it is considered and stays until its fire settles, refusals
 * included. So `inFlight() >= maxInFlight` compared a ceiling of 3 against a
 * count that included the asker -- three schedules due in one minute admitted
 * two and skipped the third with a slot sitting empty, while
 * `docs/scheduled-tasks.md` said 3 the whole time. Worse for a reservation:
 * every refiner refused BY the reservation stayed counted against it, so four
 * refiners produced one reservation refusal and two ceiling refusals blaming a
 * pool that was never full.
 */
export interface SeatCensus {
  /** Scheduler-originated spawns already dispatched and not yet settled. */
  total: number
  /** Of those, how many run under the order being admitted. */
  forOrder: number
}

export type SeatAdmission = { admit: true } | { admit: false; reason: string }

/**
 * The GLOBAL ceiling's refusal text, unchanged.
 *
 * Kept byte-identical to what `fire.ts` recorded before reservations existed:
 * it is written into `scheduled_task_runs.error` and read back in the history
 * modal, so rewording it would make every stored row disagree with every new
 * one about the same event.
 */
function ceilingReason(maxInFlight: number): string {
  return `scheduler at its concurrency ceiling (${maxInFlight})`
}

/** The reservation's refusal text -- names the order, because that is the fix. */
function reservationReason(orderId: string, reservation: number, maxInFlight: number): string {
  return `order ${orderId} holds its reserved ${reservation} of ${maxInFlight} scheduler slots`
}

/**
 * May this fire take a slot?
 *
 * ORDER OF THE TWO CHECKS MATTERS. The global ceiling is asked FIRST, so a
 * scheduler that is genuinely full reports being full rather than blaming
 * whichever order happened to ask last -- the operator reading the history
 * needs to know which of the two walls they hit, because the fixes are opposite
 * (raise the pool vs. raise one role's share).
 *
 * A fire with NO order is bounded by the global ceiling alone. That is the
 * status quo for every schedule that exists today, and it stays that way: a
 * reservation is something an order opts into, never a tax on schedules that
 * never heard of orders.
 */
export function decideSeatAdmission(args: {
  order: SeatOrder | undefined
  census: SeatCensus
  maxInFlight: number
}): SeatAdmission {
  const { order, census, maxInFlight } = args
  if (census.total >= maxInFlight) return { admit: false, reason: ceilingReason(maxInFlight) }
  if (order === undefined) return { admit: true }
  // A reservation at or above the pool is not a reservation -- it can never
  // bind, and treating it as one would spend a comparison per fire to always
  // say yes. Clamped rather than rejected: an order asking for 5 of 3 is asking
  // for "all of them", which is exactly what no reservation means.
  const reservation = Math.min(order.reservation, maxInFlight)
  if (reservation <= 0) return { admit: false, reason: reservationReason(order.order.id, 0, maxInFlight) }
  if (census.forOrder >= reservation) {
    return { admit: false, reason: reservationReason(order.order.id, reservation, maxInFlight) }
  }
  return { admit: true }
}
