/**
 * Fleet counters, derived from the pulse rows rather than tracked separately.
 *
 * Kept out of the state factory because the counters are PER SUBSCRIBER: they
 * sum only the projects that subscriber may read, so this runs once per socket
 * per flush and has to stay a cheap pure fold over a Map it does not own.
 */

import type { WallFleetCounters, WallPulseRow } from '../../shared/wall'

/** `allowed` undefined = count every project. */
export function computeCounters(
  rows: Iterable<WallPulseRow>,
  allowed?: (project: string) => boolean,
): WallFleetCounters {
  const projects = new Set<string>()
  const hosts = new Set<string>()
  let conversations = 0
  let active = 0
  let idle = 0
  let blocked = 0

  for (const row of rows) {
    if (allowed && !allowed(row.project)) continue
    conversations++
    projects.add(row.project)
    if (row.host) hosts.add(row.host)
    // A blocked conversation is blocked, never "active" -- the whole point of
    // the counter is telling work apart from a fleet waiting on a human.
    if (row.blocked) blocked++
    else if (row.status === 'active' || row.status === 'starting' || row.status === 'booting') active++
    else idle++
  }

  return { conversations, active, idle, blocked, projects: projects.size, hosts: hosts.size }
}
