/**
 * The floating chrome stack, and the rule for WHO IS ON TOP.
 *
 * The bug (Jonas, 2026-08-05): the Share popover opened UNDERNEATH the chat
 * panel. Its own `z-50` could never fix that -- both the island and the chat
 * panel carry `backdrop-blur`, and `backdrop-filter` creates a STACKING CONTEXT,
 * so that z-index only ever ordered things INSIDE the island. Between the two
 * islands, the later sibling (chat) simply won.
 *
 * The rule, in the order it resolves:
 *   1. The surface being INTERACTED with (`focus-within`) is on top. That is
 *      "the active control", whichever one it happens to be.
 *   2. Failing that, a surface with an open popover outranks a plain one, so a
 *      Share panel that was opened and then un-focused stays readable.
 *   3. Otherwise DOM order, which is the layout order.
 *
 * Doing it here -- rather than bumping the chat panel's z-index, or lifting the
 * popover's open-state into a parent -- keeps the two islands ignorant of each
 * other: a new one joins the stack by being rendered in a Layer.
 */

import type { ReactNode } from 'react'

/** One island in the stack. Anything inside it that wants to outrank its
 *  neighbours marks itself `data-canvas-popover`. */
export function CanvasIslandLayer({ children }: { children: ReactNode }) {
  return <div className="relative z-0 focus-within:z-30 has-[[data-canvas-popover]]:z-20">{children}</div>
}

/** The top-right column the layers live in. */
export function CanvasIslandStack({ children }: { children: ReactNode }) {
  return <div className="flex flex-col items-end gap-2">{children}</div>
}
