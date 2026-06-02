/**
 * Project watch registry -- the broker half of the LEASE MODEL.
 *
 * The broker owns the truth of who is viewing which project board. While >=1
 * dashboard has a project open it sends `project_watch` to the owning sentinel
 * (idempotent start/renew) on a renew interval comfortably under the lease; on
 * the last viewer leaving it sends `project_unwatch`. The lease on the sentinel
 * is the failsafe if the broker dies. On sentinel (re)connect the broker
 * re-arms every open project, since sentinel watches are in-memory.
 *
 * Subscriptions are keyed by the dashboard socket so a disconnect cleans up.
 */

import type { ServerWebSocket } from 'bun'
import { parseProjectUri } from '../shared/project-uri'

/** Lease handed to the sentinel; it self-stops if not renewed before expiry. */
const LEASE_MS = 20 * 60 * 1000
/** Renew well under the lease so a single missed tick doesn't drop the watch. */
const RENEW_MS = 7 * 60 * 1000

type Socket = ServerWebSocket<unknown>

interface Sub {
  sockets: Set<Socket>
  renew: ReturnType<typeof setInterval> | null
}

const subs = new Map<string, Sub>() // project URI -> viewers

interface Deps {
  getSentinelForProject: (project: string) => Socket | undefined
  log: (msg: string) => void
}
let deps: Deps | null = null

export function initProjectWatchRegistry(d: Deps): void {
  deps = d
}

function sendWatch(project: string): void {
  if (!deps) return
  const sentinel = deps.getSentinelForProject(project)
  if (!sentinel) {
    deps.log(`[project-watch] no sentinel connected to arm ${project}`)
    return
  }
  const projectRoot = parseProjectUri(project).path
  try {
    sentinel.send(JSON.stringify({ type: 'project_watch', projectRoot, project, leaseMs: LEASE_MS }))
  } catch {
    /* sentinel socket gone -- re-armed on its next connect */
  }
}

function sendUnwatch(project: string): void {
  if (!deps) return
  const sentinel = deps.getSentinelForProject(project)
  if (!sentinel) return
  const projectRoot = parseProjectUri(project).path
  try {
    sentinel.send(JSON.stringify({ type: 'project_unwatch', projectRoot }))
  } catch {
    /* sentinel gone -- its watches died with it */
  }
}

/** A dashboard opened a project board: arm (or renew) the watch. */
export function subscribeProjectWatch(ws: Socket, project: string): void {
  let s = subs.get(project)
  if (!s) {
    s = { sockets: new Set(), renew: null }
    subs.set(project, s)
  }
  const first = s.sockets.size === 0
  s.sockets.add(ws)
  if (first) {
    sendWatch(project)
    s.renew = setInterval(() => sendWatch(project), RENEW_MS)
    deps?.log(`[project-watch] armed ${project} (lease ${LEASE_MS / 1000}s, renew ${RENEW_MS / 1000}s)`)
  }
}

/** A dashboard closed a project board: disarm when it was the last viewer. */
export function unsubscribeProjectWatch(ws: Socket, project: string): void {
  const s = subs.get(project)
  if (!s) return
  if (s.sockets.delete(ws) && s.sockets.size === 0) {
    if (s.renew) clearInterval(s.renew)
    subs.delete(project)
    sendUnwatch(project)
    deps?.log(`[project-watch] disarmed ${project} (last viewer left)`)
  }
}

/** A dashboard socket closed: drop it from every project it was viewing. */
export function dropSocketFromWatches(ws: Socket): void {
  for (const [project, s] of Array.from(subs)) {
    if (s.sockets.delete(ws) && s.sockets.size === 0) {
      if (s.renew) clearInterval(s.renew)
      subs.delete(project)
      sendUnwatch(project)
    }
  }
}

/** A sentinel (re)connected: re-arm every open project (its watches are fresh). */
export function rearmProjectWatches(): void {
  for (const project of subs.keys()) sendWatch(project)
  if (subs.size) deps?.log(`[project-watch] re-armed ${subs.size} watch(es) after sentinel connect`)
}
