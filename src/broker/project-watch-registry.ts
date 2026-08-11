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

/** Lease handed to the sentinel; it self-stops if not renewed before expiry. */
const LEASE_MS = 20 * 60 * 1000
/** Renew well under the lease so a single missed tick doesn't drop the watch. */
const RENEW_MS = 7 * 60 * 1000

type Socket = ServerWebSocket<unknown>

interface Sub {
  /** Live subscriptions per socket -- a tab can hold several at once. */
  refs: Map<Socket, number>
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
  try {
    sentinel.send(JSON.stringify({ type: 'project_watch', project, leaseMs: LEASE_MS }))
  } catch {
    /* sentinel socket gone -- re-armed on its next connect */
  }
}

function sendUnwatch(project: string): void {
  if (!deps) return
  const sentinel = deps.getSentinelForProject(project)
  if (!sentinel) return
  try {
    sentinel.send(JSON.stringify({ type: 'project_unwatch', project }))
  } catch {
    /* sentinel gone -- its watches died with it */
  }
}

/** Total live subscriptions across every socket viewing a project. */
function refCount(s: Sub): number {
  let n = 0
  for (const c of s.refs.values()) n += c
  return n
}

/** Tear the watch down once the LAST subscriber (not the last socket) is gone. */
function disarmIfIdle(project: string, s: Sub, reason: string): void {
  if (refCount(s) > 0) return
  if (s.renew) clearInterval(s.renew)
  subs.delete(project)
  sendUnwatch(project)
  deps?.log(`[project-watch] disarmed ${project} (${reason})`)
}

/** A dashboard opened a project board: arm (or renew) the watch. */
export function subscribeProjectWatch(ws: Socket, project: string): void {
  let s = subs.get(project)
  if (!s) {
    s = { refs: new Map(), renew: null }
    subs.set(project, s)
  }
  const first = refCount(s) === 0
  s.refs.set(ws, (s.refs.get(ws) ?? 0) + 1)
  if (first) {
    sendWatch(project)
    s.renew = setInterval(() => sendWatch(project), RENEW_MS)
    deps?.log(`[project-watch] armed ${project} (lease ${LEASE_MS / 1000}s, renew ${RENEW_MS / 1000}s)`)
  } else {
    deps?.log(`[project-watch] +1 viewer on ${project} (now ${refCount(s)} across ${s.refs.size} socket(s))`)
  }
}

/** A dashboard closed a project board: disarm when it was the last subscriber. */
export function unsubscribeProjectWatch(ws: Socket, project: string): void {
  const s = subs.get(project)
  if (!s) return
  const held = s.refs.get(ws)
  if (!held) return // stray unsubscribe -- never let the count go negative
  if (held > 1) s.refs.set(ws, held - 1)
  else s.refs.delete(ws)
  deps?.log(`[project-watch] -1 viewer on ${project} (now ${refCount(s)} across ${s.refs.size} socket(s))`)
  disarmIfIdle(project, s, 'last viewer left')
}

/** A dashboard socket closed: drop ALL of its subscriptions on every project. */
export function dropSocketFromWatches(ws: Socket): void {
  for (const [project, s] of Array.from(subs)) {
    if (!s.refs.delete(ws)) continue
    disarmIfIdle(project, s, 'socket closed')
  }
}

/** A sentinel (re)connected: re-arm every open project (its watches are fresh). */
export function rearmProjectWatches(): void {
  for (const project of subs.keys()) sendWatch(project)
  if (subs.size) deps?.log(`[project-watch] re-armed ${subs.size} watch(es) after sentinel connect`)
}
