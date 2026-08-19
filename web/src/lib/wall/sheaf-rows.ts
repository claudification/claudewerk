/**
 * A6 + A4's model layer: the `/api/sheaf` response turned into the two row
 * shapes the panes render. Pure -- no clock, no store, no fetch -- so the
 * numbers are testable without a DOM.
 *
 * THE ROLLUP IS NOT RE-IMPLEMENTED HERE. `summarizeSheaf` is imported from
 * `@shared/sheaf-summary`, the same function `fleet_sheaf` hands the dispatcher.
 * This file resolves how a project LOOKS and works out a bar width; the moment
 * it started adding up costs it would be the second implementation the card
 * forbids.
 */

import { type SheafSummary, summarizeSheaf } from '@shared/sheaf-summary'
import type { GitAlert, SheafProjectSotu, SheafResponse } from '@shared/sheaf-types'
import type { ProjectLook } from '@/components/wall/use-project-look'

export interface SheafRow extends ProjectLook {
  projectUri: string
  costUsd: number
  conversations: number
  trees: number
  inputTokens: number
  outputTokens: number
  alerts: GitAlert[]
  unmergedCommits: number
  /** This project's cost as a share of the biggest row -- the mockup's rail. */
  costShare: number
}

export interface SheafView {
  windowH: number
  totals: SheafSummary['totals']
  rows: SheafRow[]
  /** Projects the summariser dropped. Rendered whenever non-zero -- silent
   *  truncation reads as "that is everything" when it is not. */
  clipped: number
}

/** `6h`, `24h`, `7d`. Hours below two days stay hours; a week is a week. */
export function sheafWindowLabel(windowH: number): string {
  if (windowH % 24 === 0 && windowH >= 48) return `${windowH / 24}d`
  return `${windowH}h`
}

/** Token counts in the mockup's width: `9.4M`, `790k`, `812`. */
export function formatTokens(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

export function sheafView(response: SheafResponse, look: (uri: string) => ProjectLook): SheafView {
  const summary = summarizeSheaf(response)
  const max = Math.max(1, ...summary.projects.map(p => p.costUsd))
  return {
    windowH: summary.windowH,
    totals: summary.totals,
    clipped: summary.clipped ?? 0,
    rows: summary.projects.map(p => ({
      ...look(p.projectUri),
      projectUri: p.projectUri,
      costUsd: p.costUsd,
      conversations: p.conversations,
      trees: p.trees,
      inputTokens: p.inputTokens,
      outputTokens: p.outputTokens,
      alerts: (p.alerts ?? []) as GitAlert[],
      unmergedCommits: p.unmergedCommits ?? 0,
      costShare: p.costUsd / max,
    })),
  }
}

/** One project's slice of the state of the union. */
export interface SotuBlock extends ProjectLook {
  projectUri: string
  /** The distilled chronicle. Absent = not enabled, or never distilled. */
  narrative?: string
  /** Why there is no narrative, said out loud rather than rendered as silence. */
  quiet?: 'not-enabled' | 'not-distilled'
  generatedAt?: number
  alerts: GitAlert[]
  contended: number
  /** Ahead-of-origin commits across this project's branches. */
  unmerged: number
}

function quietReason(sotu: SheafProjectSotu): SotuBlock['quiet'] {
  if (sotu.narrative?.trim()) return undefined
  return sotu.enabled ? 'not-distilled' : 'not-enabled'
}

/**
 * A block per project the viewer may SEE (`sotu` present). A project filtered out
 * server-side has no block at all -- that is the permission covenant, and the
 * count of what was hidden rides on the fleet union, not here.
 */
export function sotuBlocks(response: SheafResponse, look: (uri: string) => ProjectLook): SotuBlock[] {
  const out: SotuBlock[] = []
  for (const p of response.projects) {
    const sotu = p.sotu
    if (!sotu) continue
    const narrative = sotu.narrative?.trim()
    const quiet = quietReason(sotu)
    out.push({
      ...look(p.projectUri),
      projectUri: p.projectUri,
      ...(narrative ? { narrative } : {}),
      ...(quiet ? { quiet } : {}),
      ...(sotu.generatedAt ? { generatedAt: sotu.generatedAt } : {}),
      alerts: sotu.alerts,
      contended: sotu.contended,
      unmerged: sotu.branches.reduce((sum, b) => sum + b.aheadOrigin, 0),
    })
  }
  // A project with a chronicle outranks one with only alerts: the pane is called
  // STATE OF THE UNION and the prose is the state.
  return out.sort((a, b) => Number(Boolean(b.narrative)) - Number(Boolean(a.narrative)))
}

export interface SotuPill {
  key: string
  label: string
  tone: 'bad' | 'warn' | 'plain'
  title: string
}

/** The fleet git line: counts of PROJECTS carrying each alert class, plus the
 *  two honesty pills (contention, and what this viewer was not shown). */
export function fleetPills(fleet: SheafResponse['sotu']): SotuPill[] {
  if (!fleet) return []
  const pills: SotuPill[] = []
  const add = (key: string, n: number, label: string, tone: SotuPill['tone'], title: string) => {
    if (n > 0) pills.push({ key, label: `${n} ${label}`, tone, title })
  }
  add('at-risk', fleet.atRiskProjects, 'at-risk', 'bad', 'Projects with uncommitted work and no live conversation')
  add('stalled', fleet.stalledProjects, 'stalled', 'warn', 'Projects with a branch rotting behind origin/main')
  add('unpushed', fleet.unpushedProjects, 'unpushed', 'warn', 'Projects whose local main is ahead of origin')
  add('unmerged', fleet.unmergedProjects, 'unmerged', 'warn', 'Projects carrying unintegrated worktree commits')
  add('contended', fleet.contended, 'contended', 'bad', 'Targets held by 2+ conversations at once')
  add('hidden', fleet.filteredProjects, 'not shown', 'plain', 'Projects your grants exclude from this view')
  if (fleet.grounding) {
    const pct = Math.round(fleet.grounding.precision * 100)
    pills.push({
      key: 'grounding',
      label: `grounded ${pct}%`,
      tone: fleet.grounding.unknownCited > 0 ? 'bad' : 'plain',
      title: `${fleet.grounding.unknownCited} of ${fleet.grounding.citedConvs} cited conversations are not in the input`,
    })
  }
  return pills
}
