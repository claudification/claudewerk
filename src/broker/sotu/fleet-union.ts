/**
 * SOTU fleet union -- fold the visible per-project SOTU blocks into the cheap
 * zero-LLM fleet aggregate (alert union, per-class risk counts, contention,
 * input-weighted grounding). Split from fleet.ts (the per-project enrichment).
 *
 * It also builds the STATE-OF-THE-UNION ROSTER (`union.blocks`): the scoped list
 * the wall's A4 pane renders, holding only the projects that are visible AND
 * chronicle-enabled. Scoping happens here, server-side, for the same reason the
 * visibility filter does -- the panel is told what to show.
 */

import type { GitAlert } from '../../shared/protocol'
import type { SheafFleetSotu, SheafGrounding, SheafProjectSotu, SheafSotuBlock } from '../../shared/sheaf-types'

/** Input-weighted (by knownConvs) average grounding across distilled projects.
 *  Weighting by input size keeps a tiny chronicle from dominating the fleet score. */
function foldGrounding(parts: SheafGrounding[]): SheafGrounding | undefined {
  if (parts.length === 0) return undefined
  let citedConvs = 0
  let knownConvs = 0
  let unknownCited = 0
  let wPrecision = 0
  let wCoverage = 0
  let weight = 0
  for (const g of parts) {
    citedConvs += g.citedConvs
    knownConvs += g.knownConvs
    unknownCited += g.unknownCited
    const w = Math.max(1, g.knownConvs) // an empty-input chronicle still counts once
    wPrecision += g.precision * w
    wCoverage += g.coverage * w
    weight += w
  }
  return {
    precision: weight ? wPrecision / weight : 1,
    coverage: weight ? wCoverage / weight : 1,
    citedConvs,
    knownConvs,
    unknownCited,
  }
}

/** One visible project's SOTU block, still carrying the URI it belongs to -- the
 *  union needs the identity to build the roster, the aggregate numbers do not. */
export interface VisibleProjectSotu {
  projectUri: string
  sotu: SheafProjectSotu
}

/** Roster row for one chronicle-enabled project. `unmerged` is summed here so the
 *  browser is handed a number rather than the whole branch fabric a second time. */
function rosterRow({ projectUri, sotu }: VisibleProjectSotu): SheafSotuBlock {
  return {
    projectUri,
    ...(sotu.narrative ? { narrative: sotu.narrative } : {}),
    ...(sotu.generatedAt !== undefined ? { generatedAt: sotu.generatedAt } : {}),
    alerts: sotu.alerts,
    contended: sotu.contended,
    unmerged: sotu.branches.reduce((sum, b) => sum + b.aheadOrigin, 0),
  }
}

/** Fold the visible per-project SOTU blocks into the cheap fleet union, and scope
 *  the A4 roster to the chronicle-enabled ones. */
export function buildFleetUnion(visible: VisibleProjectSotu[], filteredProjects: number): SheafFleetSotu {
  const blocks = visible.map(v => v.sotu)
  const alerts = new Set<GitAlert>()
  for (const b of blocks) for (const a of b.alerts) alerts.add(a)
  const withAlert = (a: GitAlert) => blocks.filter(b => b.alerts.includes(a)).length
  const union: SheafFleetSotu = {
    projectsEnabled: blocks.filter(b => b.enabled).length,
    projectsWithNarrative: blocks.filter(b => b.narrative).length,
    alerts: [...alerts],
    contended: blocks.reduce((n, b) => n + b.contended, 0),
    atRiskProjects: withAlert('at-risk'),
    unpushedProjects: withAlert('unpushed'),
    stalledProjects: withAlert('stalled'),
    unmergedProjects: withAlert('unmerged'),
    filteredProjects,
    // THE SCOPE GATE. `enabled === false` covers both "switched off" and "never
    // configured" -- `defaultResolveSotuConfig` collapses absent to false -- so
    // one predicate answers "chronicle off or disabled".
    blocks: visible.filter(v => v.sotu.enabled).map(rosterRow),
  }
  const grounding = foldGrounding(blocks.flatMap(b => (b.grounding ? [b.grounding] : [])))
  if (grounding) union.grounding = grounding
  return union
}
