/**
 * Project watch SET fan-out -- the wire half of the standing watch.
 *
 * The registry decides WHICH boards should be watched; this module decides WHO
 * to tell. A project URI names its owning sentinel in its authority, so the
 * union has to be partitioned per sentinel socket: each one is sent the set it
 * owns and nothing else, or a sentinel would tear down watches for boards that
 * were never its to begin with.
 *
 * Level-triggered on purpose. `project_watch` / `project_unwatch` are edge
 * messages -- lose one and a watcher runs forever or a board stays dark with
 * nothing to correct it. A set converges: the sentinel diffs it against its live
 * watches every time it arrives, so a dropped message costs one heartbeat.
 */

import type { ServerWebSocket } from 'bun'
import type { ProjectUnwatch, ProjectWatch, ProjectWatchSet } from '../shared/protocol'

type Socket = ServerWebSocket<unknown>

export interface WatchSetDeps {
  getSentinelForProject: (project: string) => Socket | undefined
  log: (msg: string) => void
}

/** Send without caring whether the socket died mid-flight -- a sentinel that
 *  vanished is re-armed by `rearmProjectWatches()` on its next connect. */
function post(sentinel: Socket, msg: ProjectWatch | ProjectUnwatch | ProjectWatchSet): void {
  try {
    sentinel.send(JSON.stringify(msg))
  } catch {
    /* socket gone -- next connect re-arms */
  }
}

/**
 * Everyone told to watch something by the previous fan-out.
 *
 * Needed because an EMPTY union resolves to no sentinel at all -- there is no
 * project left to look one up by -- so a naive implementation sends nothing and
 * the last watch survives until its lease expires 20 minutes later. Remembering
 * the recipients makes "now watch nothing" deliverable to exactly the sockets
 * that need to hear it.
 */
let lastRecipients = new Set<Socket>()

/**
 * Partition `projects` by owning sentinel and send each one its full set.
 *
 * Returns the number of sockets written to, so the caller can log a fan-out of
 * zero (every project orphaned) distinctly from a quiet no-op.
 */
export function sendWatchSets(projects: string[], leaseMs: number, deps: WatchSetDeps): number {
  const bySentinel = new Map<Socket, string[]>()
  const orphaned: string[] = []

  for (const project of projects) {
    const sentinel = deps.getSentinelForProject(project)
    if (!sentinel) {
      orphaned.push(project)
      continue
    }
    const owned = bySentinel.get(sentinel)
    if (owned) owned.push(project)
    else bySentinel.set(sentinel, [project])
  }

  // A sentinel that held boards last time and holds none now must be told so
  // explicitly; it cannot infer an empty set from silence.
  for (const sentinel of lastRecipients) {
    if (!bySentinel.has(sentinel)) bySentinel.set(sentinel, [])
  }

  for (const [sentinel, owned] of bySentinel) {
    post(sentinel, { type: 'project_watch_set', projects: owned, leaseMs })
  }

  lastRecipients = new Set(
    Array.from(bySentinel)
      .filter(([, owned]) => owned.length > 0)
      .map(([s]) => s),
  )

  if (orphaned.length > 0) {
    deps.log(`[project-watch] ${orphaned.length} project(s) have no connected sentinel: ${orphaned.join(', ')}`)
  }
  return bySentinel.size
}

/** Drop the recipient memory (broker shutdown / registry re-init). */
export function resetWatchSetRecipients(): void {
  lastRecipients = new Set()
}

/**
 * COMPATIBILITY BRIDGE -- delete once every sentinel in the fleet speaks
 * `project_watch_set`.
 *
 * The sentinel ships as a frozen bundle updated by `build:packages`, so a broker
 * deploy can land in front of a sentinel that has never heard of the set. Its
 * message switch has no default branch, so it drops the unknown type silently
 * and every board would go dark -- a live regression in the panel, caused by a
 * fix for something else entirely.
 *
 * So viewer-armed projects keep getting the old edge messages too. A current
 * sentinel receives both and converges identically (`watchProject` is
 * idempotent, and the set is a superset of the viewer projects by construction,
 * so the two can never disagree).
 */
export function sendLegacyWatch(project: string, leaseMs: number, deps: WatchSetDeps): void {
  const sentinel = deps.getSentinelForProject(project)
  if (!sentinel) return
  post(sentinel, { type: 'project_watch', project, leaseMs })
}

/** Legacy half of the bridge: only fires for a project that left the union
 *  entirely, never for one that merely lost its last viewer while remaining in
 *  the standing interest set. */
export function sendLegacyUnwatch(project: string, deps: WatchSetDeps): void {
  const sentinel = deps.getSentinelForProject(project)
  if (!sentinel) return
  post(sentinel, { type: 'project_unwatch', project })
}
