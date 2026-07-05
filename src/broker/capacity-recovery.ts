/**
 * CAPACITY RECOVERY -- §14 boot reconstruction of the reservation ledger.
 *
 * A free function (not a ledger method) because it's a BOOT concern, distinct
 * from the live dispatch path: a fresh ledger + this call == the pre-restart
 * ledger, so a broker restart mid-run never loses or double-counts reserved
 * capacity. Uses only the ledger's public surface (`reserve` + `defaultEstimate`).
 */

import { fmt } from './capacity-decision'
import type { CapacityLedger } from './capacity-ledger'
import type { InflightConvView } from './capacity-types'

/**
 * Rebuild outstanding reservations from the in-flight nightshift conversations.
 * Estimate basis = each conv's tokens-used-so-far (a live figure), floored at the
 * ledger's default estimate. Keyed by the SAME runId:taskId ref the live dispatch
 * path uses so a settle lands cleanly. Call on a FRESH ledger only.
 */
export function reconstructLedger(ledger: CapacityLedger, convs: InflightConvView[]): void {
  for (const c of convs) {
    const profile = c.resolvedProfile ?? 'default'
    const estimate = Math.max(ledger.defaultEstimate, c.usedTokens)
    const { runId, taskId } = c.nightshift
    ledger.reserve(
      { project: c.project, runId, taskId },
      profile,
      estimate,
      `${runId}:${taskId}`,
      `reconstruct after restart: ${c.id.slice(0, 8)} on ${profile} (${fmt(estimate)} tok in flight)`,
    )
  }
}
