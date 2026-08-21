/**
 * THE FOUR SEATS, AS WORK ORDERS.
 *
 * `epic-spawn-plan.ts` used to hardcode what an OVERSEER, a PLANNER, an
 * IMPLEMENTER and a GUARD are: the name prefix, whether it gets a worktree,
 * which prompt builder it uses, whether it may speak to a human. Four seats,
 * none of them a thing you could read without reading the broker, and a fifth
 * seat meant editing the broker.
 *
 * A FIFTH SEAT NO LONGER MEANS EDITING THE BROKER, and it no longer means
 * editing this file either. `order@1`'s `seat` is an open name and an order may
 * carry its own `instructions`, so a REFINER or a DOC-WRITER is a new order
 * file and nothing else. What stayed closed is THIS map -- the seats the epic
 * ENGINE dispatches -- because a scheduler seat has no meaning inside a
 * generation. `orderRole()` is where the two meet, and it refuses.
 *
 * These are the same four seats, declared. The compile step in
 * `epic-spawn-plan.ts` reads them; nothing about the dispatched seats changed
 * when they moved here, which is the property `epic-spawn-plan.test.ts` pins.
 *
 * THEY GO THROUGH `validateOrder` LIKE ANY OTHER ORDER. Exporting hand-written
 * literals would leave the repo's own orders as the only ones that never met
 * the validator -- and the validator is where the flag allowlist and the
 * command-line character allowlist live. If one of these ever stops being a
 * legal `order@1`, the module fails to load rather than dispatching something
 * the schema would have refused from a stranger.
 *
 * WHAT IS DELIBERATELY NOT SET HERE: model, effort and per-seat budget. Every
 * one of them is a real capability of `order@1` and every one of them would be
 * a BEHAVIOUR CHANGE -- the seats run today on the project default, and this
 * card is a refactor whose acceptance test is that the engine emits what it
 * emitted before. "A GUARD does not need Opus-tier budget to read a diff" is
 * true and it is the next card's to prove, one seat at a time, with the run
 * data to say whether it hurt.
 */

import type { EpicRole } from './epic-run-types'
import { type Order, type OrderSeat, validateOrder } from './order'

/**
 * THE FOUR SEATS THE EPIC ENGINE DISPATCHES. Closed, and closed HERE.
 *
 * `OrderSeat` is an open name -- any lowercase-kebab string is a legal seat for
 * an `order@1`, which is what makes a REFINER or a DOC-WRITER possible without
 * a schema edit. This union is the other half of that: the epic engine still
 * has exactly four seats, it still wants the compiler to tell it when one is
 * missing an order, and a seat outside these four still has no meaning to a
 * beat. Opening the schema did not open the ENGINE, and conflating the two is
 * how a scheduler-only seat would end up dispatched into a generation.
 */
export type EpicOrderSeat = 'overseer' | 'planner' | 'implementer' | 'verifier'

/**
 * The seat -> launch-tag role map.
 *
 * PLANNER IS THE OVERSEER SEAT WITH A DIFFERENT PROMPT, and the shared tag is
 * not laziness: `overseerAlive` is what stops the engine dispatching underneath
 * a live supervisor, and a planning generation needs exactly that guard. A
 * `planner` role tag would make generation 0 invisible to the check whose whole
 * job is to hold the beat.
 */
const SEAT_ROLE: Record<EpicOrderSeat, EpicRole> = {
  overseer: 'overseer',
  planner: 'overseer',
  implementer: 'implementer',
  verifier: 'verifier',
}

/** Is this seat one the epic engine knows how to dispatch? */
export function isEpicOrderSeat(seat: OrderSeat): seat is EpicOrderSeat {
  return Object.hasOwn(SEAT_ROLE, seat)
}

/**
 * Which `EpicRole` a seat reports as, or `undefined` if it never enters the
 * epic engine. The non-throwing half, for a caller that wants to ASK.
 */
export function orderSeatRole(seat: OrderSeat): EpicRole | undefined {
  return isEpicOrderSeat(seat) ? SEAT_ROLE[seat] : undefined
}

/**
 * Which `EpicRole` an order's seat reports as. Drives the mute and the tag.
 *
 * IT REFUSES A NON-EPIC SEAT RATHER THAN MAPPING ONE. `OrderSeat` is open, so
 * `SEAT_ROLE[order.seat]` would now hand back `undefined` for a `refiner` and
 * that `undefined` would travel: `buildEpicWorkerSettings(role, ...)` decides
 * the MUTE from the role, and `mayAskHuman(undefined)` is falsy -- so the seat
 * would be dispatched, silently muted, tagged with an epic role that is not a
 * role, and only visible as a hole in the panel. A throw is the correct answer
 * because there is no right role for a seat the engine does not run: a
 * scheduler seat reaching `compileSeat` is a routing bug upstream, and the
 * cheap thing is to fail at the compile step where the caller is still on the
 * stack.
 */
export function orderRole(order: Order): EpicRole {
  const role = orderSeatRole(order.seat)
  if (!role) {
    throw new Error(
      `order ${order.id} fills seat "${order.seat}", which the epic engine does not dispatch ` +
        `(it has: ${Object.keys(SEAT_ROLE).sort().join(', ')})`,
    )
  }
  return role
}

/**
 * Every seat runs `bypassPermissions`, and the reasoning lives in
 * `epic-spawn-plan.ts`'s `EpicPermissionMode` doc: `dontAsk` denies anything not
 * on `permissions.allow`, you cannot enumerate what a coding agent needs, and
 * what actually stops a runaway is the deny-floor hook plus worktree isolation
 * -- both of which are mode-independent.
 *
 * Declared once here rather than four times so a future decision to narrow one
 * seat is visibly a decision about THAT seat.
 */
const BYPASS = { permissionMode: 'bypassPermissions' } as const

/**
 * THE OVERSEER. No worktree: it reads the board, answers questions and merges
 * on main, and an isolated checkout would hide the very state it exists to
 * judge. The only seat whose settings leave the human channels open.
 */
export const OVERSEER_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: 'OVERSEER@1',
  title: 'Overseer -- decides what happens next, and the only seat that may ask a human',
  seat: 'overseer',
  prompt: 'overseer',
  caps: BYPASS,
  notes:
    'Singleton per epic, one generation per beat. Not muted: the mute exists so no worker BLOCKS on a human, ' +
    'and the overseer is the seat the blocking is routed TO.',
})

/**
 * THE PLANNER -- generation 0, in the overseer seat with a different prompt.
 * No worktree, for the overseer's reason: it edits the board, which lives on
 * main.
 */
export const PLANNER_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: 'PLANNER@1',
  title: 'Planner -- completes the dependency graph before anything dispatches',
  seat: 'planner',
  prompt: 'planner',
  namePrefix: 'planner ',
  caps: BYPASS,
  notes:
    'Runs once, before beat 1. Reads every card and the epic intent, closes what is already done, files what ' +
    'is missing, and writes the `depends_on` edges nobody declared -- so dispatch arithmetic has a complete graph.',
})

/**
 * AN IMPLEMENTER. Own worktree named for the card, own branch, muted.
 *
 * The empty worktree prefix is the ordinary case and is written out rather than
 * left absent, because an ABSENT `worktree` means something else entirely here:
 * no worktree at all, which is what the overseer and the planner get.
 */
export const IMPLEMENTER_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: 'IMPLEMENTER@1',
  title: 'Implementer -- one card, one worktree, no human',
  seat: 'implementer',
  prompt: 'implementer',
  worktree: { prefix: '' },
  caps: BYPASS,
  notes:
    'Cannot ask a question, cannot approve its own work, cannot decide the epic direction. Each of those is ' +
    "somebody else's job, and every one of them used to be quietly absorbed by whichever agent got stuck.",
})

/**
 * A GUARD -- the verifier. Its scratch worktree is its OWN, separate from the
 * implementer's, and it is given the card plus the diff, never the
 * implementer's conversation: a reviewer that reads the coder's reasoning
 * inherits the coder's blind spots.
 */
export const GUARD_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: 'GUARD@1',
  title: 'Guard -- the quality gate, which does not trust the worker',
  seat: 'verifier',
  prompt: 'guard',
  namePrefix: 'verify ',
  worktree: { prefix: 'verify-' },
  caps: BYPASS,
  notes:
    'Re-runs `test_cmd` and every acceptance step itself. Muted like an implementer: it judges, it does not ' +
    'escalate -- a verifier that can reach a human turns every hard call into a question.',
})

/**
 * Every seat the engine can dispatch, keyed by seat.
 *
 * Keyed by {@link EpicOrderSeat}, NOT by `OrderSeat`: the schema's seat name is
 * open, and `Record<OrderSeat, Order>` after that opening would have degraded
 * to `Record<string, Order>` -- which type-checks a map that is missing the
 * verifier, and hands back `undefined` for every seat that is not here.
 */
export const EPIC_ORDERS: Record<EpicOrderSeat, Order> = {
  overseer: OVERSEER_ORDER,
  planner: PLANNER_ORDER,
  implementer: IMPLEMENTER_ORDER,
  verifier: GUARD_ORDER,
}
