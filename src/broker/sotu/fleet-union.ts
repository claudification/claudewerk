/**
 * SOTU fleet union -- fold the visible per-project SOTU blocks into the cheap
 * zero-LLM fleet aggregate (alert union, per-class risk counts, contention,
 * input-weighted grounding). Split from fleet.ts (the per-project enrichment).
 */

import type { GitAlert } from '../../shared/protocol'
import type { SheafFleetSotu, SheafGrounding, SheafProjectSotu } from '../../shared/sheaf-types'

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

/** Fold the visible per-project SOTU blocks into the cheap fleet union. */
export function buildFleetUnion(blocks: SheafProjectSotu[], filteredProjects: number): SheafFleetSotu {
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
  }
  const grounding = foldGrounding(blocks.flatMap(b => (b.grounding ? [b.grounding] : [])))
  if (grounding) union.grounding = grounding
  return union
}
