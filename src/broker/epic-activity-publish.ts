/**
 * PUSHING THE ACTIVITY FEED TO THE CONTROL PANEL.
 *
 * The header badge must answer "is anything running" without asking, and the
 * covenant is WS over HTTP polling: a badge that polls is a badge that costs a
 * request every few seconds forever, on every open tab, whether or not anything
 * is happening. The engine already wakes on a 45s cadence and already knows the
 * answer, so the answer travels on that wake.
 *
 * ONE MESSAGE PER PROJECT, carrying only that project's rows. That fan-out is
 * not incidental -- it is what lets `broadcastConversationScoped` do the
 * permission gating that already exists, instead of this message inventing a
 * filter of its own. A viewer with chat:read on one project sees one message and
 * counts one project's runs.
 *
 * A project with nothing running still gets a message with an EMPTY array, for
 * exactly one tick after its last run settles. Without that the client would
 * keep showing the final pre-settle state forever, since "nothing to say" and
 * "nothing running" look identical over a push channel.
 */

import type { EpicActivityEntry } from '../shared/protocol'
import { listActiveEpicRuns } from './epic-active'
import type { SweepDeps } from './epic-sweep-loop'

/** The slice of the store this needs. Structural, so a test passes a spy. */
export interface ActivityBroadcaster {
  broadcastConversationScoped: (message: Record<string, unknown>, project: string) => void
}

/**
 * Projects that had rows on the PREVIOUS publish. Kept so a project whose last
 * run just went terminal receives one final empty message and the badge clears.
 * Dropped from the set once that empty message has been sent, so an idle box
 * broadcasts nothing at all.
 */
const lastPublished = new Set<string>()

function byProject(rows: EpicActivityEntry[]): Map<string, EpicActivityEntry[]> {
  const map = new Map<string, EpicActivityEntry[]>()
  for (const row of rows) {
    const list = map.get(row.project)
    if (list) list.push(row)
    else map.set(row.project, [row])
  }
  return map
}

/**
 * Compute the feed and push it. Never throws: a publish failure must not take
 * down the sweep that called it -- the engine's job is to run the epic, and a
 * control panel that missed one tick catches up on the next one.
 */
export async function publishEpicActivity(deps: SweepDeps, target: ActivityBroadcaster): Promise<void> {
  try {
    const grouped = byProject(await listActiveEpicRuns(deps))

    for (const [project, epicActivity] of grouped) {
      target.broadcastConversationScoped({ type: 'epic_activity', project, epicActivity }, project)
      lastPublished.add(project)
    }

    for (const project of [...lastPublished]) {
      if (grouped.has(project)) continue
      target.broadcastConversationScoped({ type: 'epic_activity', project, epicActivity: [] }, project)
      lastPublished.delete(project)
    }
  } catch (err) {
    deps.log(`[epic-activity] publish failed: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Tests only -- the module-level set would otherwise leak between cases. */
export function resetActivityPublisher(): void {
  lastPublished.clear()
}
