/**
 * Nightshift guardian action log -- a broker-local ring of every guardian action
 * (pokes, investigator spawns, retries, cap-hits, terminal-error stamps). Sibling
 * to `nightshift-watchdog-log.ts`: the guardians push here; the ring is the live,
 * within-process tail (the artifacts + the §6c push are the durable record).
 *
 * Pure + dependency-free. LOG EVERYTHING: nothing the guardian decides is a
 * diag-only line -- it is a GuardianEvent here + a project-scoped broadcast.
 */

import type { GuardianEvent } from '../shared/protocol'

/** Hard ceiling on retained events. Guardians act rarely (only on dead/crashed
 *  tasks), so this drains slowly; older entries fall off the tail. */
const MAX_EVENTS = 1000

/** Newest-last ring. Shared single-process singleton -- one broker, one guardian loop. */
const events: GuardianEvent[] = []

/** Append one event, evicting the oldest once the ring is full. */
export function recordGuardianEvent(event: GuardianEvent): void {
  events.push(event)
  if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
}

export interface RecentGuardianQuery {
  /** Restrict to one project URI. */
  project?: string
  /** Restrict to one run. */
  runId?: string
  /** Cap the number of NEWEST events returned. */
  limit?: number
}

/** Newest-first slice of the ring matching the filter. Fresh array each call. */
export function getRecentGuardianEvents(query: RecentGuardianQuery = {}): GuardianEvent[] {
  const { project, runId, limit = 200 } = query
  const out: GuardianEvent[] = []
  for (let i = events.length - 1; i >= 0 && out.length < limit; i--) {
    const e = events[i]
    if (project && e.project !== project) continue
    if (runId && e.runId !== runId) continue
    out.push(e)
  }
  return out
}

/** Test-only: wipe the ring between cases. */
export function __clearGuardianEventsForTest(): void {
  events.length = 0
}
