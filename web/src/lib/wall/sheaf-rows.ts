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

import { type SheafProjectSummary, type SheafSummary, summarizeSheaf } from '@shared/sheaf-summary'
import type { GitAlert, SheafResponse, SheafStatus } from '@shared/sheaf-types'
import type { ProjectLook } from '@/components/wall/use-project-look'
import { projectMatchesStatus } from '@/sheaf/sheaf-derive'

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
  /** Projects `projectHasSomethingToSay` sent home. Same honesty rule as
   *  `clipped`, different reason: those were too expensive to fit, these had
   *  nothing to report. Kept apart so the footer can say which. */
  quiet: number
}

/**
 * WHAT A ROW HAS TO SAY -- the four things the predicate below weighs, pulled
 * off `SheafProjectSummary` plus the one fact the rollup does not carry.
 *
 * It is a struct rather than four positional arguments so the test can state a
 * case ("alert only") in the shape the predicate reads it.
 */
export interface SheafRowClaim {
  /** A conversation RUNNING right now, anywhere in this project's forest. The
   *  rollup counts conversations but not their status, so this comes off the raw
   *  response -- see `sheafView`. */
  live: boolean
  costUsd: number
  inputTokens: number
  outputTokens: number
  /** SOTU escalations: at-risk / unpushed / stalled. */
  alerts: readonly string[]
  unmergedCommits: number
}

/**
 * DOES THIS PROJECT EARN ITS ROW? Jonas, 2026-08-20: *"sheaf panel: need to show
 * only active, or projects with information in them!"*.
 *
 * ANY of four clauses keeps a project: it is live, it burned something in the
 * window, it carries a git alert, or it has commits nobody has merged. The last
 * two are the reason this is not `costUsd > 0` -- a dormant project sitting on
 * eleven unpushed commits is quiet AND the most important row on the pane.
 *
 * DELIBERATELY NOT INSIDE `summarizeSheaf`. That function is shared with the
 * dispatcher's `fleet_sheaf` context (which is why it was moved to `src/shared`
 * in `f09dc3a2`), and a filter in there would silently narrow what the
 * dispatcher knows about the fleet. The wall filters at ITS read; every other
 * consumer sees the list it always saw.
 */
export function projectHasSomethingToSay(claim: SheafRowClaim): boolean {
  return (
    claim.live ||
    claim.costUsd > 0 ||
    claim.inputTokens > 0 ||
    claim.outputTokens > 0 ||
    claim.alerts.length > 0 ||
    claim.unmergedCommits > 0
  )
}

/** Clause 1's status set. `projectMatchesStatus` treats an EMPTY set as "match
 *  everything", so this staying non-empty is what keeps the clause meaningful. */
const LIVE_STATUSES: Set<SheafStatus> = new Set(['running'])

const claimOf = (p: SheafProjectSummary, live: boolean): SheafRowClaim => ({
  live,
  costUsd: p.costUsd,
  inputTokens: p.inputTokens,
  outputTokens: p.outputTokens,
  alerts: p.alerts ?? [],
  unmergedCommits: p.unmergedCommits ?? 0,
})

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
  // Liveness is the one clause the rollup cannot answer, so it is read off the
  // raw forests here and joined by URI -- the rollup keeps its own shape.
  const live = new Set(response.projects.filter(p => projectMatchesStatus(p, LIVE_STATUSES)).map(p => p.projectUri))
  const kept = summary.projects.filter(p => projectHasSomethingToSay(claimOf(p, live.has(p.projectUri))))
  const max = Math.max(1, ...kept.map(p => p.costUsd))
  return {
    windowH: summary.windowH,
    totals: summary.totals,
    clipped: summary.clipped ?? 0,
    quiet: summary.projects.length - kept.length,
    rows: kept.map(p => ({
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

/** One project's slice of the state of the union: a server roster row, with the
 *  project's look resolved onto it. */
export interface SotuBlock extends ProjectLook {
  projectUri: string
  /** The distilled chronicle. Absent = chronicle ON, nothing distilled yet -- a
   *  chronicle-OFF project is not on the roster at all. */
  narrative?: string
  generatedAt?: number
  alerts: GitAlert[]
  contended: number
  /** Ahead-of-origin commits across this project's branches. */
  unmerged: number
}

/**
 * The state-of-the-union roster, looked up.
 *
 * THE SCOPE IS NOT DECIDED HERE. This reads `response.sotu.blocks`, which the
 * broker already scoped twice: to the projects this viewer may SEE (the
 * permission covenant) and to the projects whose chronicle is ON (Jonas: *"DO NOT
 * SHOW projects that have chronicle off"*). Filtering `response.projects` in the
 * browser would put the second gate on the wrong side of the wire -- the panel
 * would be handed the hidden rows and trusted to drop them.
 */
export function sotuBlocks(response: SheafResponse, look: (uri: string) => ProjectLook): SotuBlock[] {
  const out: SotuBlock[] = []
  for (const b of response.sotu?.blocks ?? []) {
    const narrative = b.narrative?.trim()
    out.push({
      ...look(b.projectUri),
      projectUri: b.projectUri,
      ...(narrative ? { narrative } : {}),
      ...(b.generatedAt ? { generatedAt: b.generatedAt } : {}),
      alerts: b.alerts,
      contended: b.contended,
      unmerged: b.unmerged,
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
