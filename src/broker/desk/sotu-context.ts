/**
 * The `<sotu>` LIVE BLOCK -- State of the Union folded into the dispatcher's
 * per-turn context, so the narrative fleet truth (distilled chronicle + git
 * escalation alerts + CONTENDED collisions) is in front of the model at ALL
 * times, not just behind a tool call.
 *
 * Zero-LLM on the hot path: it reads the current chronicle + live queue via
 * `buildSotuView` (the ONE Phase-5 read model) -- freshness is the SOTU
 * engine's job (activity trigger + read-triggered regen), never this block's.
 * Rebuilt in place each impulse like the other live blocks; a project with
 * nothing to say contributes nothing.
 */

import type { SotuView } from '../../shared/protocol'
import { buildSotuView, projectSlug } from '../sotu'
import type { ProjectOverviewRow } from './overview'

/** Budget for the whole `<sotu>` block (chars). Detail beyond this stays
 *  reachable via the state_of_union tool (progressive memory). */
const DEFAULT_SOTU_BUDGET_CHARS = 1400

/** Clip the narrative to its first meaningful lines, bounded. */
function headline(narrative: string, maxChars: number): string {
  const lines = narrative
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean)
    .slice(0, 2)
  const joined = lines.join(' ')
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1)}…` : joined
}

export type SotuViewOf = (projectUri: string, now: number) => SotuView | null

/** Default reader: the real SOTU store. Degrades to null when the store is not
 *  initialized (unit tests, cold boot) -- the block simply omits the project. */
function readView(projectUri: string, now: number): SotuView | null {
  try {
    return buildSotuView({ slug: projectSlug(projectUri), project: projectUri, enabled: true, now })
  } catch {
    return null
  }
}

/** One compact per-project section, or null when there is nothing to say. */
export function sotuSection(label: string, view: SotuView): string | null {
  const parts: string[] = []
  const narrative = view.chronicle.narrative.trim()
  if (narrative) parts.push(headline(narrative, 200))
  if (view.alerts.length) parts.push(`git: ${view.alerts.join(', ')}`)
  const contended = view.holds.filter(h => h.contended)
  if (contended.length) {
    const targets = contended
      .slice(0, 3)
      .map(h => h.target)
      .join(', ')
    parts.push(`CONTENDED (${contended.length}): ${targets}`)
  }
  if (!parts.length) return null
  return `## ${label}\n${parts.join('\n')}`
}

export interface SotuBlockOpts {
  budgetChars?: number
  /** Injectable view reader (tests). Defaults to the live SOTU store. */
  viewOf?: SotuViewOf
}

/**
 * Build the `<sotu>` block body for the active per-turn context rows (rows
 * arrive attention-then-recency ordered, so the pack keeps the vivid projects).
 * Returns '' when no project has narrative/alerts/contention -- the block is
 * then dropped entirely, costing zero context.
 */
export function buildSotuBlockBody(rows: ProjectOverviewRow[], now: number, opts: SotuBlockOpts = {}): string {
  const viewOf = opts.viewOf ?? readView
  const budget = opts.budgetChars ?? DEFAULT_SOTU_BUDGET_CHARS
  const sections: string[] = []
  let remaining = budget
  let dropped = 0
  for (const r of rows) {
    const view = viewOf(r.projectUri, now)
    if (!view) continue
    const section = sotuSection(r.project, view)
    if (!section) continue
    if (section.length + 2 <= remaining) {
      sections.push(section)
      remaining -= section.length + 2
    } else {
      dropped++
    }
  }
  if (!sections.length) return ''
  const tail = dropped ? `\n\n(+${dropped} more -- use state_of_union)` : ''
  return sections.join('\n\n') + tail
}
