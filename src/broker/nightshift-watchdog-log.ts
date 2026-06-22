/**
 * Nightshift watchdog decision log -- a broker-local ring buffer of every
 * consideration the deterministic WATCHDOG made (plan-nightshift.md §2.4 +
 * the LOG-EVERYTHING covenant). EVERY tick records a decision per live night
 * task -- not just the kills -- so the live Status screen (§2.5) can show the
 * watchdog's full reasoning, timestamped.
 *
 * Pure + dependency-free: the watchdog loop pushes decisions here; the
 * `nightshift_watchdog_request` handler reads them back for Status-screen
 * backfill. Live decisions are broadcast separately by the loop (it owns the
 * scoped-broadcast fn); this module is just the durable-within-process tail.
 */

import type { WatchdogDecision } from '../shared/protocol'

/** Hard ceiling on retained decisions. A ~1-min sweep over a handful of night
 *  tasks fills this slowly; older entries fall off the tail (the Result screen
 *  + artifacts are the durable record, this ring is the live tail). */
const MAX_DECISIONS = 1000

/** Newest-last ring. Shared single-process singleton -- one broker, one watchdog. */
const decisions: WatchdogDecision[] = []

/** Append one decision, evicting the oldest once the ring is full. */
export function recordWatchdogDecision(decision: WatchdogDecision): void {
  decisions.push(decision)
  if (decisions.length > MAX_DECISIONS) decisions.splice(0, decisions.length - MAX_DECISIONS)
}

export interface RecentDecisionsQuery {
  /** Restrict to one project URI (the Status screen is per-project, like Result). */
  project?: string
  /** Restrict to one run. */
  runId?: string
  /** Cap the number of NEWEST decisions returned. */
  limit?: number
}

/**
 * Newest-first slice of the ring matching the filter. Returns a fresh array
 * (callers may sort/serialize freely). Default cap = 200.
 */
export function getRecentWatchdogDecisions(query: RecentDecisionsQuery = {}): WatchdogDecision[] {
  const { project, runId, limit = 200 } = query
  const out: WatchdogDecision[] = []
  // Walk newest-first; stop once we have `limit`.
  for (let i = decisions.length - 1; i >= 0 && out.length < limit; i--) {
    const d = decisions[i]
    if (project && d.project !== project) continue
    if (runId && d.runId !== runId) continue
    out.push(d)
  }
  return out
}

/** Test-only: wipe the ring between cases. */
export function __clearWatchdogDecisionsForTest(): void {
  decisions.length = 0
}
