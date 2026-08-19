/**
 * THE SHEAF ROLLUP -- one compaction of `SheafResponse` into per-project numbers,
 * shared by the two things that want it: the dispatcher's `fleet_sheaf` tool and
 * THE WALL's A6 pane.
 *
 * It used to live in `broker/desk/fleet-sheaf.ts`, which is unreachable from the
 * web bundle (`web/tsconfig.json` maps `@shared/*` at `src/shared` and nothing
 * else). The wall card had two ways out: teach `/api/sheaf` a second response
 * shape, or move the PURE function to where both callers can import it. This is
 * the second. There is no `?summary=` mode and no second route -- the pane
 * fetches the same `GET /api/sheaf` the Sheaf modal already fetches and runs
 * THIS function on the response, so "the wall's numbers match `summarizeSheaf()`"
 * is true by construction rather than by a test that compares two implementations.
 *
 * `desk/fleet-sheaf.ts` keeps the broker-side provider singleton and re-exports
 * these names, so the dispatcher path is unchanged.
 */

import type { SheafProject, SheafResponse } from './sheaf-types'

/** Compact per-project rollup for the model. Numbers only, no forests. */
export interface SheafProjectSummary {
  /** Canonical project URI -- the stable bucket key. Labels collide (two repos
   *  can both end in `web`); anything resolving an identity keys on this. */
  projectUri: string
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
    projectUri: p.projectUri,
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
