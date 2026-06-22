/**
 * PROJECTS-overview composer for the dispatcher BRAIN (plan-dispatcher-brain.md
 * P5 `projects_overview`). The fleet by PROJECT -- each known project + its
 * condensed brief + live/working/needs-you counts -- so "what's going on?" hits
 * CONDENSED MEMORY anchored on projects, NOT a raw list_conversations dump.
 *
 * Projects with ZERO live conversations still appear (the `arr` case) because
 * the project set comes from the registry, not from the live roster. Pure: it
 * takes projects + briefs + a light conversation view, so it unit-tests without
 * the store.
 */

export interface OverviewConv {
  projectKey: string | null
  ended: boolean
  liveState?: string
  lastActivity?: number
}

export interface ProjectOverviewRow {
  project: string
  projectUri: string
  /** The condensed durable brief (may be '' if not yet learned). */
  brief: string
  /** Live (non-ended) conversations in this project. */
  live: number
  /** Currently working. */
  working: number
  /** Flagged needs_you / blocked -- where the user's attention is wanted. */
  needsYou: number
  /** Minutes since the most recent activity in the project, if any. */
  idleMin?: number
}

export interface ProjectLike {
  key: string
  projectUri: string
  label: string
}

interface Counts {
  live: number
  working: number
  needsYou: number
  lastActivity: number
}

function tally(convs: OverviewConv[]): Map<string, Counts> {
  const by = new Map<string, Counts>()
  for (const c of convs) {
    if (!c.projectKey || c.ended) continue
    const cur = by.get(c.projectKey) ?? { live: 0, working: 0, needsYou: 0, lastActivity: 0 }
    cur.live++
    if (c.liveState === 'working') cur.working++
    if (c.liveState === 'needs_you' || c.liveState === 'blocked') cur.needsYou++
    if (c.lastActivity && c.lastActivity > cur.lastActivity) cur.lastActivity = c.lastActivity
    by.set(c.projectKey, cur)
  }
  return by
}

/**
 * Compose the project-anchored overview. Ordered by attention then recency:
 * projects wanting you first, then by most-recent activity, then the rest
 * (idle/learned-but-quiet) alphabetically.
 */
export function composeProjectsOverview(
  projects: ProjectLike[],
  briefByKey: Map<string, string>,
  conversations: OverviewConv[],
  now: number,
): ProjectOverviewRow[] {
  const counts = tally(conversations)
  const rows: ProjectOverviewRow[] = projects.map(p => {
    const c = counts.get(p.key)
    const row: ProjectOverviewRow = {
      project: p.label,
      projectUri: p.projectUri,
      brief: briefByKey.get(p.key) ?? '',
      live: c?.live ?? 0,
      working: c?.working ?? 0,
      needsYou: c?.needsYou ?? 0,
    }
    if (c?.lastActivity) row.idleMin = Math.round((now - c.lastActivity) / 60000)
    return row
  })
  return rows.sort((a, b) => {
    if (a.needsYou !== b.needsYou) return b.needsYou - a.needsYou
    if (a.live !== b.live) return b.live - a.live
    const ai = a.idleMin ?? Number.POSITIVE_INFINITY
    const bi = b.idleMin ?? Number.POSITIVE_INFINITY
    if (ai !== bi) return ai - bi
    return a.project.localeCompare(b.project)
  })
}
