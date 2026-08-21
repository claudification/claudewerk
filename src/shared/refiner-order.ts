/**
 * `REFINER@1` -- the seat that drains `#needs-refine`, as a work order.
 *
 * `quick-task-needs-refine-keypress` puts `#needs-refine` on a card with one
 * keypress and nothing consumes it. This is the consumer's SEAT: the reusable
 * half of the dispatch -- who does it, what it may spend, what it may touch.
 * SELECTING the tagged cards and dispatching against them is `scanner-refine`'s
 * half, in the sibling epic, and there is deliberately no dispatcher here.
 *
 * WHY AN ORDER AND NOT A FOURTH `TASK_MODES` ENTRY. `task-modes.ts` hardcodes
 * three roles with their persona baked into the source -- exactly the shape
 * `werk-work-orders` indicts. A role you cannot read, diff, version or cap is a
 * role that quietly grows a fourth copy of itself. `TASK_MODES` should collapse
 * INTO orders when `order@1` is everywhere; growing it first would be building
 * the thing we are replacing.
 *
 * WHAT `order@1` CANNOT HOLD YET, and why this file has a wrapper type.
 * `OrderCaps` has model, effort, agent, budget, permission mode and MCP config.
 * It has no `maxTurns`, and there is no way to express "this role may hold at
 * most N of the scheduler's slots" -- both are real caps a role carries, and
 * both are carried by {@link SeatOrder} alongside the order until the schema
 * grows them (card `order-caps-turns-and-reservation`). The order files
 * themselves belong to `werk-work-orders` and are deliberately NOT edited here.
 */

import { type Order, validateOrder } from './order'

/** The one id a scheduled task names to spend this seat. */
export const REFINER_ORDER_ID = 'REFINER@1'

/**
 * The instruction block the refiner seat runs.
 *
 * TWO THINGS IT MUST GET RIGHT, and both are in here as imperatives rather than
 * left to the seat's judgement:
 *
 *   1. IT REMOVES THE TAG. The tag IS the queue. A refiner that improves a card
 *      and leaves `#needs-refine` on it refines that card again every cron tick,
 *      forever, and the queue never drains.
 *   2. IT EDITS THE BODY, NOT THE STATUS. A card that got clearer did not get
 *      done. The prose below says so and {@link REFINER_ORDER}'s deny rule makes
 *      it mechanical -- the seat cannot call the status verb at all.
 *
 * Derived from `TASK_MODES`' `refine.single` so the two do not drift while both
 * exist; the additions are the tag removal and the explicit no-status clause.
 *
 * THE MODEL SUGGESTION (step 7) IS IN BOTH COPIES, and it has to be: a refiner
 * reached from the LAUNCH modal runs `TASK_MODES.refine.single`, one reached
 * from this seat runs the block below, and a hint only one of them asks for is a
 * hint that appears or vanishes depending on which door the refine came through.
 */
export const REFINER_INSTRUCTIONS = `REFINE this card -- do not implement it.
1. Read the card file for full context, and the code it points at
2. Rewrite the description so it is specific about what must happen
3. Add missing tags and set an appropriate priority
4. Break it into smaller, actionable sub-tasks if it is too large
5. Note any dependencies on other cards
6. REMOVE the \`needs-refine\` tag from the card's \`tags:\` line -- the tag is the
   queue, and a card you refined but left tagged comes back to you forever
7. Set \`model:\` to the model this work actually needs (\`haiku\`, \`sonnet\`,
   \`opus\`, \`fable\`) and say WHY in one line in the body. You have just read the
   card and the code it points at, so you are the one who knows whether this is a
   rename-three-symbols job or a design job -- that judgement is thrown away
   unless you write it down. It is a HINT: a seat's own order may clamp it down,
   never up.

Edit the card file itself. Do NOT change the card's status (you cannot -- the
status verb is denied to this seat), and do NOT start implementing the work.`

/**
 * `REFINER@1`.
 *
 * SEAT IS `implementer`, AND THAT IS A COMPROMISE WORTH NAMING. `OrderSeat` is
 * a closed union over the four seats of the EPIC engine, so `refiner` is not
 * currently a value an order may carry. The implementer seat is the closest
 * true statement -- given one card, edits files, muted, may not approve its own
 * work -- and nothing in the epic engine ever reads this order: it is spent by
 * the scheduler, and `EPIC_ORDERS` (the epic engine's lookup) does not contain
 * it. Opening the union is `order-seat-union-is-closed`.
 *
 * NO WORKTREE, for the overseer's reason: the board lives in the main checkout
 * and a card refined inside an isolated worktree is a card nobody else sees.
 *
 * `bypassPermissions` IS THE NARROW CHOICE HERE, counter-intuitively, and the
 * reasoning is `epic-orders.ts`': `dontAsk` denies everything not on an allow
 * list, you cannot enumerate what an agent needs, and an unattended seat that
 * hits a prompt hangs until the watchdog reaps it. What actually bounds this
 * seat is the deny rules below plus the budget -- both mode-independent. The
 * order still cannot WIDEN anyone: `composeOrderCaps` runs the composed mode
 * through the real trust gate, so a non-benevolent caller gets a refusal, and a
 * caller already narrower than bypass keeps its own mode.
 */
export const REFINER_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: REFINER_ORDER_ID,
  title: 'Refiner -- makes a rough card buildable, and drains #needs-refine',
  seat: 'implementer',
  prompt: 'implementer',
  namePrefix: 'refine ',
  caps: {
    // Rewriting a four-word capture into a spec is the cheapest thing the fleet
    // does. "A GUARD does not need Opus-tier budget to read a diff" applied one
    // rung further down.
    model: 'claude-haiku-4-5',
    effort: 'low',
    maxBudgetUsd: 0.5,
    permissionMode: 'bypassPermissions',
  },
  permissions: {
    // THE STATUS VERB, DENIED. `flipsStatus: false` in `TASK_MODES` is a flag a
    // prompt builder may or may not honour; this is the same rule enforced by
    // the harness. A refiner that moved a card to in-review would be lying on
    // the board about work that never happened.
    deny: ['mcp__rclaude__project_set_status'],
  },
  notes:
    'Spent by a scheduled task against #needs-refine cards. Removes the tag it drains and changes no statuses. ' +
    'Must run BEFORE the nightly board sweep: refinement bumps card mtimes, and the sweep short-circuits on the ' +
    "board's max mtime -- refine after the snapshot and every night looks like movement.",
})

/**
 * An order plus the caps `order@1` cannot express yet.
 *
 * The split is temporary and the fields are here rather than invented into
 * `order.ts` because that file belongs to another card in flight. When the
 * schema grows them, `maxTurns` moves into `caps` and `reservation` alongside
 * it, and this type collapses to `Order`.
 */
export interface SeatOrder {
  order: Order
  /** The instruction block handed to the seat. */
  instructions: string
  /**
   * Turn ceiling for ONE seat. DECLARED, NOT YET ENFORCED: `OrderCaps` has no
   * `maxTurns` and `SpawnRequest` has no field to carry it either, so nothing
   * downstream reads this today -- the only turn cap in the repo belongs to
   * `nightshift-watchdog`. It is stated here because it is a real property of
   * the role and a number somebody has to pick; wiring it is the same card that
   * adds it to `OrderCaps`.
   */
  maxTurns: number
  /**
   * How many scheduler slots this order may hold AT ONCE.
   *
   * The scheduler caps itself at `MAX_CONCURRENT_SCHEDULED_SPAWNS` (3) globally.
   * That cap is the seat pool, and without a per-order share a backlog of 40
   * tagged cards takes all three -- the nightly sweep and the recap simply never
   * fire. One of three leaves two permanently reachable by everything else.
   *
   * This is a property of the ORDER, which is what makes it sayable at all:
   * card (the work), tag (the routing) and order (the seat) stay three separate
   * things precisely so "refiners get 1 of 3" has somewhere to live.
   */
  reservation: number
}

/** `REFINER@1`, with the caps that do not fit in `order@1` yet. */
export const REFINER: SeatOrder = {
  order: REFINER_ORDER,
  instructions: REFINER_INSTRUCTIONS,
  // A card is one file. Read it, read what it points at, rewrite it, drop the
  // tag. A refiner still going at 30 turns has stopped refining and started
  // implementing, which is the failure this seat exists to not do.
  maxTurns: 30,
  reservation: 1,
}

/** Every seat order a scheduled task may name, by order id. */
export const SEAT_ORDERS: Readonly<Record<string, SeatOrder>> = {
  [REFINER_ORDER_ID]: REFINER,
}

/**
 * The seat order for an id, or `undefined`.
 *
 * An UNKNOWN id returns `undefined` rather than throwing: a schedule naming an
 * order that a later build removed must keep firing on the plain path, not go
 * dark. The caller decides whether the absence matters.
 */
export function seatOrder(orderId: string | undefined): SeatOrder | undefined {
  return orderId === undefined ? undefined : SEAT_ORDERS[orderId]
}
