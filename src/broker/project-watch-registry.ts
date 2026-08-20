/**
 * Project watch registry -- the broker half of the LEASE MODEL.
 *
 * TWO sources of interest, unioned:
 *
 * 1. STANDING -- every project scope with a recently-active conversation. This
 *    is the floor and it does not care who is looking. Derived from the store on
 *    the renew heartbeat.
 * 2. VIEWERS -- refcounted dashboards with a project board open. Adds projects
 *    the standing set misses (a board nobody has held a conversation in) and
 *    arms them the instant they are opened, rather than up to one heartbeat
 *    later.
 *
 * The standing half exists because the CARD LEDGER is a ledger. Until 2026-08-20
 * the viewer refcount was the ONLY source, so the board was watched exactly when
 * someone had it on screen -- and every lane change made by an unattended run
 * went unrecorded. `card_moves` held 0 rows against a fully-shipped feature. A
 * ledger that only records while you watch it is a dashboard.
 *
 * Subscriptions are keyed by the dashboard socket so a disconnect cleans up --
 * but they are COUNTED, not just tracked. One tab is one socket, and a tab has
 * many independent subscribers on the same project (the transcript's task
 * editor, the Kanban board, the command palette's task mode, the input
 * autocomplete, ...), each sending its own subscribe/unsubscribe as it mounts
 * and unmounts. Treating the socket as the refcount let the FIRST unmount
 * disarm the watch under everyone else, and a board that is still on screen
 * then silently misses every out-of-band move (`project_set_status`) until
 * something re-armed from zero.
 */

import type { ServerWebSocket } from 'bun'
import {
  resetWatchSetRecipients,
  sendLegacyUnwatch,
  sendLegacyWatch,
  sendWatchSets,
  type WatchSetDeps,
} from './project-watch-set'

/** Lease handed to the sentinel; it self-stops if not renewed before expiry. */
const LEASE_MS = 20 * 60 * 1000
/** Renew well under the lease so a single missed tick doesn't drop the watch.
 *  Doubles as the standing-set refresh, so a brand-new project's board joins
 *  within one tick -- and instantly if anyone opens it, via the viewer half. */
const RENEW_MS = 7 * 60 * 1000
/**
 * How far back a conversation counts as making its project worth watching.
 *
 * Measured on this box 2026-08-20: 125 scopes all-time, 48 active in 30 days,
 * 31 in 7. A watch costs one fs watcher plus a 5s manifest poll, timed at
 * 12.5 ms per tick for the largest board here (527 cards) -- 0.25% of a core.
 * 30 days is generous precisely because the unit cost is that small; the window
 * exists to keep dead projects from accumulating watchers forever, not to
 * ration a scarce resource.
 */
export const PROJECT_INTEREST_WINDOW_MS = 30 * 24 * 60 * 60 * 1000

type Socket = ServerWebSocket<unknown>

const viewers = new Map<string, Map<Socket, number>>() // project URI -> socket -> refs
let standing: string[] = []
let heartbeat: ReturnType<typeof setInterval> | null = null

interface Deps extends WatchSetDeps {
  /** The standing interest set: project scopes worth watching unattended. */
  listInterestProjects: () => string[]
}
let deps: Deps | null = null

export function initProjectWatchRegistry(d: Deps): void {
  deps = d
  // Init means init: a second call starts from a clean slate rather than
  // inheriting viewers and an interest set belonging to the previous one.
  viewers.clear()
  standing = []
  resetWatchSetRecipients()
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = setInterval(() => {
    refreshStandingSet()
    syncWatchSet('heartbeat')
  }, RENEW_MS)
  refreshStandingSet()
  syncWatchSet('init')
}

/** Test seam + clean shutdown: one interval, one owner. */
export function stopProjectWatchRegistry(): void {
  if (heartbeat) clearInterval(heartbeat)
  heartbeat = null
}

/** Union of both sources, deduped and stable-ordered so a log line is diffable. */
function effectiveSet(): string[] {
  const all = new Set(standing)
  for (const [project, refs] of viewers) if (refs.size > 0) all.add(project)
  return Array.from(all).sort()
}

/** Re-read the interest set. Logs only on a CHANGE -- a healthy fleet is quiet. */
function refreshStandingSet(): void {
  if (!deps) return
  let next: string[]
  try {
    next = Array.from(new Set(deps.listInterestProjects())).sort()
  } catch (err) {
    // A store read must never take the heartbeat down: keep the previous set,
    // which is still correct, and say so loudly.
    deps.log(`[project-watch] interest set refresh FAILED, keeping ${standing.length}: ${String(err)}`)
    return
  }
  const added = next.filter(p => !standing.includes(p))
  const removed = standing.filter(p => !next.includes(p))
  standing = next
  if (added.length > 0 || removed.length > 0) {
    deps.log(
      `[project-watch] standing set now ${next.length} project(s)` +
        `${added.length ? ` +[${added.join(', ')}]` : ''}${removed.length ? ` -[${removed.join(', ')}]` : ''}`,
    )
  }
}

/** Push the current union to every owning sentinel. */
function syncWatchSet(reason: string): void {
  if (!deps) return
  const projects = effectiveSet()
  const sockets = sendWatchSets(projects, LEASE_MS, deps)
  deps.log(
    `[project-watch] set sync (${reason}): ${projects.length} project(s) -> ${sockets} sentinel(s) ` +
      `(standing ${standing.length}, viewed ${viewers.size}, lease ${LEASE_MS / 1000}s)`,
  )
}

/** Total live subscriptions across every socket viewing a project. */
function refCount(refs: Map<Socket, number>): number {
  let n = 0
  for (const c of refs.values()) n += c
  return n
}

/** Drop an empty viewer entry, and tell the sentinel only if the project left
 *  the union entirely -- a viewed project that is also in the standing set must
 *  keep its watch when the last tab closes. */
function releaseIfIdle(project: string, refs: Map<Socket, number>, reason: string): void {
  if (refCount(refs) > 0) return
  viewers.delete(project)
  const stillWanted = standing.includes(project)
  deps?.log(
    `[project-watch] last viewer left ${project} (${reason}) -- ${stillWanted ? 'KEPT (standing set)' : 'released'}`,
  )
  if (!stillWanted && deps) sendLegacyUnwatch(project, deps)
  syncWatchSet('viewer-release')
}

/** A dashboard opened a project board: arm (or renew) the watch. */
export function subscribeProjectWatch(ws: Socket, project: string): void {
  let refs = viewers.get(project)
  if (!refs) {
    refs = new Map()
    viewers.set(project, refs)
  }
  const first = refCount(refs) === 0
  refs.set(ws, (refs.get(ws) ?? 0) + 1)
  if (!first) {
    deps?.log(`[project-watch] +1 viewer on ${project} (now ${refCount(refs)} across ${refs.size} socket(s))`)
    return
  }
  // Arm this one immediately rather than waiting for the heartbeat: an opened
  // board expects live moves now. The legacy edge message rides along for a
  // sentinel that predates the set (see the bridge note in project-watch-set).
  if (deps) sendLegacyWatch(project, LEASE_MS, deps)
  deps?.log(`[project-watch] armed ${project} (viewer, lease ${LEASE_MS / 1000}s)`)
  syncWatchSet('viewer-arm')
}

/** A dashboard closed a project board: release when it was the last subscriber. */
export function unsubscribeProjectWatch(ws: Socket, project: string): void {
  const refs = viewers.get(project)
  if (!refs) return
  const held = refs.get(ws)
  if (!held) return // stray unsubscribe -- never let the count go negative
  if (held > 1) refs.set(ws, held - 1)
  else refs.delete(ws)
  deps?.log(`[project-watch] -1 viewer on ${project} (now ${refCount(refs)} across ${refs.size} socket(s))`)
  releaseIfIdle(project, refs, 'last viewer left')
}

/** A dashboard socket closed: drop ALL of its subscriptions on every project. */
export function dropSocketFromWatches(ws: Socket): void {
  for (const [project, refs] of Array.from(viewers)) {
    if (!refs.delete(ws)) continue
    releaseIfIdle(project, refs, 'socket closed')
  }
}

/** A sentinel (re)connected: its watches are in-memory and therefore empty, so
 *  re-send the whole set. Refresh first -- a reconnect after a long absence is
 *  exactly when the interest set is most likely to have moved on. */
export function rearmProjectWatches(): void {
  refreshStandingSet()
  syncWatchSet('sentinel-connect')
}
