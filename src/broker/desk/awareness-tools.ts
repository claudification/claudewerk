/**
 * The dispatcher's AWARENESS tools -- full-fidelity State of the Union + the
 * Sheaf fleet ledger, on demand (the `<sotu>` live block carries the headline;
 * these page the detail in, the progressive-memory pattern).
 *
 * `state_of_union` is READ-triggered-fresh: it awaits `maybeDistillOnRead`
 * (lazy regen -- stale chronicle gets an Opus re-ground, pending items a cheap
 * scribe fold, fresh+quiet costs nothing) before serving, so the dispatcher
 * always relays current truth. `fleet_sheaf` is zero-LLM structural numbers.
 */

import { z } from 'zod'
import type { SotuView } from '../../shared/protocol'
import { buildSotuView, maybeDistillOnRead, projectSlug } from '../sotu'
import { renderSotuBrief } from '../sotu/view'
import { getFleetSheafProvider, summarizeSheaf } from './fleet-sheaf'
import { listDeskProjects, resolveDeskProject } from './projects'
import { sotuSection } from './sotu-context'
import { defineTool, type Toolset } from './tool-def'

/** Injectable seams (tests). Defaults are the live SOTU engine + sheaf provider. */
export interface AwarenessDeps {
  viewOf?: (projectUri: string, now: number) => SotuView | null
  distillOnRead?: (projectUri: string) => Promise<unknown>
  sheafOf?: (windowH: number) => ReturnType<typeof summarizeSheaf> | null
}

function readView(projectUri: string, now: number): SotuView | null {
  try {
    return buildSotuView({ slug: projectSlug(projectUri), project: projectUri, enabled: true, now })
  } catch {
    return null
  }
}

function liveSheaf(windowH: number): ReturnType<typeof summarizeSheaf> | null {
  const provider = getFleetSheafProvider()
  return provider ? summarizeSheaf(provider(windowH)) : null
}

/** Full SOTU for one project: lazily regenerated, then the assembled view. */
async function projectUnion(
  projectQuery: string,
  viewOf: NonNullable<AwarenessDeps['viewOf']>,
  distillOnRead: NonNullable<AwarenessDeps['distillOnRead']>,
): Promise<Record<string, unknown>> {
  const dp = resolveDeskProject(projectQuery)
  if (!dp) return { error: `no project matching "${projectQuery}"` }
  // Read-triggered regen: stale -> Opus reconcile, pending -> scribe fold,
  // fresh+quiet -> no-op. Failure degrades to the current chronicle.
  await distillOnRead(dp.projectUri).catch(() => null)
  const view = viewOf(dp.projectUri, Date.now())
  if (!view) return { project: dp.label, note: 'no SOTU data recorded for this project yet' }
  return {
    project: dp.label,
    brief: renderSotuBrief(view, dp.label) || '(nothing to report)',
    narrative: view.chronicle.narrative,
    generatedAt: view.chronicle.generatedAt || undefined,
    alerts: view.alerts,
    holds: view.holds.map(h => ({
      kind: h.kind,
      target: h.target,
      holders: h.holders.length,
      contended: h.contended,
      etaHint: h.etaHint,
    })),
  }
}

/** Fleet mode: the zero-LLM union of every project's current SOTU floor. */
function fleetUnion(viewOf: NonNullable<AwarenessDeps['viewOf']>): Record<string, unknown> {
  const now = Date.now()
  const sections: string[] = []
  for (const p of listDeskProjects()) {
    const view = viewOf(p.projectUri, now)
    if (!view) continue
    const section = sotuSection(p.label, view)
    if (section) sections.push(section)
  }
  return sections.length
    ? { fleet: sections.join('\n\n') }
    : { fleet: '', note: 'no project has SOTU narrative, git alerts, or contention right now' }
}

export function awarenessTools(deps: AwarenessDeps = {}): Toolset {
  const viewOf = deps.viewOf ?? readView
  const distillOnRead = deps.distillOnRead ?? maybeDistillOnRead
  const sheafOf = deps.sheafOf ?? liveSheaf
  return {
    state_of_union: defineTool({
      description:
        'The State of the Union: the distilled "where are we" narrative for a project, plus git escalation alerts (at-risk / unpushed / stalled), active claims/stakes, and CONTENDED collisions. Pass a project for the full, freshly-regenerated chronicle; pass null for the fleet-wide floor (every project with something to say). The <sotu> block in your context is the headline -- call this for the detail.',
      inputSchema: z.object({
        project: z.string().nullable().describe('Project name/slug/uri for full detail, or null for the fleet union.'),
      }),
      idempotent: true,
      execute: a => {
        const { project } = a as { project: string | null }
        return project ? projectUnion(project, viewOf, distillOnRead) : fleetUnion(viewOf)
      },
    }),

    fleet_sheaf: defineTool({
      description:
        'The Sheaf: the structural fleet ledger over a time window -- per-project cost (USD), token totals, conversation/tree counts, unmerged commits, and git alerts. Zero LLM cost. Use for "what did we spend", "how busy was project X", or any quantitative fleet question; state_of_union is the narrative counterpart.',
      inputSchema: z.object({
        windowH: z
          .number()
          .int()
          .positive()
          .nullable()
          .describe('Window in hours (default 24, max 168). Null = default.'),
      }),
      idempotent: true,
      execute: a => {
        const { windowH } = a as { windowH: number | null }
        const summary = sheafOf(Math.min(windowH ?? 24, 168))
        return summary ?? { error: 'sheaf unavailable (provider not bound in this runtime)' }
      },
    }),
  }
}
