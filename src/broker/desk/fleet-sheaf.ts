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
 */

import type { SheafProject, SheafResponse } from '../../shared/sheaf-types'

export type FleetSheafProvider = (windowH: number) => SheafResponse

let provider: FleetSheafProvider | null = null

/** Bind the live sheaf builder. Called once at broker boot. */
export function setFleetSheafProvider(fn: FleetSheafProvider): void {
  provider = fn
}

export function getFleetSheafProvider(): FleetSheafProvider | null {
  return provider
}

/** Compact per-project rollup for the model. Numbers only, no forests. */
export interface SheafProjectSummary {
  project: string
  costUsd: number
  conversations: number
  trees: number
  inputTokens: number
  outputTokens: number
  /** SOTU escalation alerts when the response was enriched (at-risk/unpushed/stalled). */
  alerts?: string[]
  /** Unmerged commits sitting on this project's worktree branches. */
  unmergedCommits?: number
}

export interface SheafSummary {
  windowH: number
  totals: { projects: number; conversations: number; trees: number; costUsd: number }
  projects: SheafProjectSummary[]
  /** How many low-cost projects were clipped from the list (never silent). */
  clipped?: number
}

const MAX_PROJECTS = 20

function countConvs(p: SheafProject): number {
  let n = 0
  const stack = [...p.forest]
  while (stack.length) {
    const node = stack.pop()
    if (!node) continue
    n++
    stack.push(...node.children)
  }
  return n
}

function summarizeProject(p: SheafProject): SheafProjectSummary {
  const row: SheafProjectSummary = {
    project: p.label,
    costUsd: Math.round(p.totals.cost.amount * 100) / 100,
    conversations: countConvs(p),
    trees: p.forest.length,
    inputTokens: p.totals.tokens.input,
    outputTokens: p.totals.tokens.output,
  }
  if (p.sotu?.alerts.length) row.alerts = p.sotu.alerts
  const unmerged = p.sotu?.branches.reduce((sum, b) => sum + b.aheadOrigin, 0) ?? 0
  if (unmerged > 0) row.unmergedCommits = unmerged
  return row
}

/** Compact the full SheafResponse to what the dispatcher's context can afford.
 *  Projects arrive cost-sorted from the builder; keep the top slice. */
export function summarizeSheaf(sheaf: SheafResponse, maxProjects: number = MAX_PROJECTS): SheafSummary {
  const projects = sheaf.projects.slice(0, maxProjects).map(summarizeProject)
  const out: SheafSummary = {
    windowH: sheaf.windowH,
    totals: {
      projects: sheaf.totals.projects,
      conversations: sheaf.totals.conversations,
      trees: sheaf.totals.trees,
      costUsd: Math.round(sheaf.totals.cost.amount * 100) / 100,
    },
    projects,
  }
  const clipped = sheaf.projects.length - projects.length
  if (clipped > 0) out.clipped = clipped
  return out
}
