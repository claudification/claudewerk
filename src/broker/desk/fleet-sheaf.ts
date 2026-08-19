/**
 * SHEAF access for the dispatcher -- the structural fleet ledger (cost / tokens /
 * conversation trees per project over a time window) made reachable from the
 * agent loop at all times.
 *
 * The full sheaf builder (handlers/sheaf-build.ts) needs the StoreDriver +
 * conversation store + termination log, which the desk deliberately does not
 * hold. So the broker BOOT binds a provider here once (module singleton, same
 * pattern as initDispatchMemory / setHistoryNotifier), and the `fleet_sheaf`
 * tool degrades gracefully when unbound (unit tests, partial harnesses).
 *
 * The raw SheafResponse is far too big for the dispatcher's tiny context
 * (full spawn forests), so `summarizeSheaf` compacts it to per-project rollup
 * numbers -- the dispatcher wants "where is the money/time going", not trees.
 *
 * THAT COMPACTION NOW LIVES IN `src/shared/sheaf-summary.ts` and is re-exported
 * here. THE WALL's A6 pane runs the same function on the same `/api/sheaf`
 * response, and the web bundle can only import from `src/shared`. Moving the
 * pure function was the alternative to giving the route a second response shape;
 * every caller here keeps importing `summarizeSheaf` from this module.
 */

import type { SheafResponse } from '../../shared/sheaf-types'

export { type SheafProjectSummary, type SheafSummary, summarizeSheaf } from '../../shared/sheaf-summary'

export type FleetSheafProvider = (windowH: number) => SheafResponse

let provider: FleetSheafProvider | null = null

/** Bind the live sheaf builder. Called once at broker boot. */
export function setFleetSheafProvider(fn: FleetSheafProvider): void {
  provider = fn
}

export function getFleetSheafProvider(): FleetSheafProvider | null {
  return provider
}
