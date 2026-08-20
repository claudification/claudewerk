/**
 * A hover preview that is already ANSWERED -- no lookup, no fetch, no provider.
 *
 * Some rows already hold everything their preview says (a pulse row knows its
 * model, host, cost and context pressure; it just cannot show them on one line).
 * For those, a panel that re-resolves anything would be a second source of truth
 * for data the row is rendering from. So the caller hands over the finished
 * strings and the panel is a dumb renderer.
 *
 * The point of the shape being DATA and not a component: the hover layer stays
 * one system. A surface that needs a preview describes it here instead of
 * growing a popover of its own.
 */

export interface HoverFacts {
  /** Small uppercase kicker -- what KIND of thing this is (`pulse`, `commit`). */
  kicker: string
  /** The headline. Wraps; never truncated -- the row already truncated it. */
  title: string
  /** Label/value pairs, in reading order. Empty values are dropped by the
   *  panel, so a caller never has to build the list conditionally. */
  facts: Array<[string, string]>
  /** Free text under the facts: the action line in full, a commit body. */
  body?: string
  /** Shown under everything, dimmed -- provenance, a branch, a project. */
  footer?: string
}

/** Drop the pairs with nothing to say. A blank value reads as "unknown", which
 *  is a different claim from "this row has no host". */
export function liveFacts(facts: Array<[string, string]>): Array<[string, string]> {
  return facts.filter(([, value]) => value !== '' && value !== undefined)
}
