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
 * THERE IS NO WRAPPER TYPE LEFT, and that is the whole of
 * `order-caps-turns-and-reservation`. This file shipped a `SeatOrder` -- an
 * `Order` plus the two things `order@1` could not say -- and every one of them
 * has now moved onto the artifact itself:
 *
 *   `instructions`   moved by `order-seat-union-is-closed`, along with the open
 *                    seat name, so `REFINER@1` stopped declaring
 *                    `seat: 'implementer', prompt: 'implementer'` and says what
 *                    it actually is.
 *   `maxTurns`       now `caps.maxTurns`, and ENFORCED rather than declared:
 *                    `composeOrderCaps` narrows it onto the `SpawnRequest` and
 *                    the sentinel spends it as CC's `--max-turns`.
 *   `reservation`    now `Order.reservation`, read by `decideSeatAdmission`.
 *
 * So a seat order IS an `Order`, and `REFINER@1` is one constant rather than a
 * constant wrapped in another one. A wrapper beside a schema is a schema that
 * lost an argument, and every reader after it has to learn both halves.
 */

import { EPIC_SOFT_LINK_STEP } from './epic-roster'
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
 * STEP 6 IS IMPORTED, not written here, for that same reason -- `epic-roster.ts`
 * owns both the roster block and the sentence that tells a seat what to do with
 * it, so the scanner seat and the panel's refine cannot disagree about when a
 * card may be parented.
 *
 * THE MODEL SUGGESTION (step 8) IS IN BOTH COPIES, and it has to be: a refiner
 * reached from the LAUNCH modal runs `TASK_MODES.refine.single`, one reached
 * from this seat runs the block below, and a hint only one of them asks for is a
 * hint that appears or vanishes depending on which door the refine came through.
 *
 * IT WENT IN LAST, AFTER THE TAG DRAIN, NOT BEFORE IT. The drain's number is
 * quoted by `refine-scanner.ts`, its test and `seat-reservation.test.ts`; a new
 * step inserted above it silently invalidates all three. Append-only numbering
 * is the same rule the card schema's render order follows, for the same reason.
 */
export const REFINER_INSTRUCTIONS = `REFINE this card -- do not implement it.
1. Read the card file for full context, and the code it points at
2. Rewrite the description so it is specific about what must happen
3. Add missing tags and set an appropriate priority
4. Break it into smaller, actionable sub-tasks if it is too large
5. Note any dependencies on other cards
6. ${EPIC_SOFT_LINK_STEP}
7. REMOVE the \`needs-refine\` tag from the card's \`tags:\` line -- the tag is the
   queue, and a card you refined but left tagged comes back to you forever
8. Set \`model:\` to the model this work actually needs (\`haiku\`, \`sonnet\`,
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
 * SEAT IS `refiner`, AND IT CARRIES ITS OWN INSTRUCTIONS. It used to declare
 * `seat: 'implementer', prompt: 'implementer'` -- the closest true statement
 * available while `OrderSeat` was a closed union over the epic engine's four
 * and `prompt` had to name one of the broker's four compiled-in builders. It
 * was a MISLABEL and it was inert only because nothing in the epic engine reads
 * this order: it is spent by the scheduler and by `refine-scanner`, and
 * `EPIC_ORDERS` (the epic engine's lookup) does not contain it. A second
 * non-epic seat would have made it stop being inert.
 *
 * NO `prompt`, BY THE SAME TOKEN. The four builders compile a CARD into an epic
 * seat's prompt; a refiner is handed one card by a scheduler that has no
 * generation, no beat and no baton, so naming one of them was never true either.
 * `orderRole(REFINER_ORDER)` THROWS, and that refusal is the point -- see
 * `epic-orders.ts`.
 *
 * NO WORKTREE, for the overseer's reason: the board lives in the main checkout
 * and a card refined inside an isolated worktree is a card nobody else sees.
 *
 * `auto`, for `epic-orders.ts`' reasoning: an ALLOWLIST is what does not work
 * for a coding agent (you cannot enumerate what it needs, and an unattended seat
 * that hits a prompt hangs until the watchdog reaps it), and the answer to that
 * is a classifier, not an absence of one. What ALSO bounds this seat is the deny
 * rules below plus the budget, both mode-independent, and both unchanged.
 *
 * The order still cannot WIDEN anyone: `composeOrderCaps` runs the composed mode
 * through the real trust gate, and `narrowestMode` keeps whichever of the base
 * and the order sits lower on the ladder -- so a caller already at `plan` stays
 * at `plan`.
 */
export const REFINER_ORDER: Order = validateOrder({
  kind: 'order@1',
  id: REFINER_ORDER_ID,
  title: 'Refiner -- makes a rough card buildable, and drains #needs-refine',
  seat: 'refiner',
  instructions: REFINER_INSTRUCTIONS,
  namePrefix: 'refine ',
  // Was implied by `bypassPermissions`; now stated, for `epic-orders.ts`' reason.
  minTrust: 'benevolent',
  caps: {
    // Rewriting a four-word capture into a spec is the cheapest thing the fleet
    // does. "A GUARD does not need Opus-tier budget to read a diff" applied one
    // rung further down.
    model: 'claude-haiku-4-5',
    effort: 'low',
    maxBudgetUsd: 0.5,
    // A card is one file. Read it, read what it points at, rewrite it, drop the
    // tag. A refiner still going at 30 turns has stopped refining and started
    // implementing, which is the failure this seat exists to not do -- and it is
    // a failure the BUDGET does not catch, because 30 haiku turns are cheap.
    maxTurns: 30,
    permissionMode: 'auto',
  },
  // ONE OF THE SCHEDULER'S THREE. Forty tagged cards must not hold every slot:
  // the nightly board sweep fires once, at a fixed minute, and does not retry.
  reservation: 1,
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

/** Every seat order a scheduled task may name, by order id. NOT exported: the
 *  registry is an implementation detail of {@link seatOrder}, and an exported
 *  table nobody reads is the second way to look an order up. */
const SEAT_ORDERS: Readonly<Record<string, Order>> = {
  [REFINER_ORDER_ID]: REFINER_ORDER,
}

/**
 * The seat order for an id, or `undefined`.
 *
 * An UNKNOWN id returns `undefined` rather than throwing: a schedule naming an
 * order that a later build removed must keep firing on the plain path, not go
 * dark. The caller decides whether the absence matters.
 */
export function seatOrder(orderId: string | undefined): Order | undefined {
  return orderId === undefined ? undefined : SEAT_ORDERS[orderId]
}
