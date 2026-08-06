/**
 * The PLACE card's INTEGRATION line, derived from the last git-fabric snapshot.
 *
 * Pure and read-only on purpose. The snapshot is whatever the last scan left
 * behind; this counts it and stamps its age. Nothing here may cause a scan --
 * the card renders "as of 12m ago", which is an honest answer, where a scan on
 * hover would be a 15s sentinel round trip per pointer move.
 */

import type { GitFabric } from '../../shared/protocol'

export interface IntegrationSummary {
  /** Branches carrying commits origin/main has never seen (loss risk). */
  unpushed: number
  /** Unmerged branches that have drifted far behind origin/main (rotting). */
  stalled: number
  /** Worktrees with uncommitted changes. */
  dirty: number
  /** Branches whose merge would conflict today. */
  conflicts: number
  branches: number
  /** When the scan ran, and how fresh its view of origin/main was. */
  scannedAt: number | null
  fetchedAt: number | null
}

const EMPTY_INTEGRATION: IntegrationSummary = {
  unpushed: 0,
  stalled: 0,
  dirty: 0,
  conflicts: 0,
  branches: 0,
  scannedAt: null,
  fetchedAt: null,
}

export function summarizeIntegration(fabric: GitFabric | undefined): IntegrationSummary {
  if (!fabric) return { ...EMPTY_INTEGRATION }
  const summary: IntegrationSummary = {
    ...EMPTY_INTEGRATION,
    branches: fabric.branches.length,
    scannedAt: fabric.scannedAt ?? null,
    fetchedAt: fabric.fetchedAt ?? null,
  }
  for (const branch of fabric.branches) {
    // `aheadOrigin > 0` is the git-observable floor; the `unpushed` ALERT is the
    // sharpened version and only ever a subset, so count the floor.
    if (branch.aheadOrigin > 0) summary.unpushed++
    if (branch.alerts.includes('stalled')) summary.stalled++
    if (branch.dirty) summary.dirty++
    if (branch.integration === 'conflicts') summary.conflicts++
  }
  return summary
}
