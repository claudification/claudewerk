/**
 * THE WALL singleton + the publish seams every producer calls.
 *
 * ONE hub per broker process. Producers never touch the hub or its state
 * directly -- they call a `publishWall*` seam, which is a no-op while nobody is
 * watching. That gate is what makes "no wall open => zero extra broker work"
 * true at the SOURCE rather than at the socket.
 *
 * Two of the six sections have no producer in this codebase yet: `hosts`
 * belongs to `wall-host-vitals` and `plan` to `wall-plan-usage-series`. Their
 * seams are live and typed -- those cards call `publishWallHostVitals` /
 * `publishWallPlanSample` and their data appears on the wall with no change
 * here.
 */

import type { ServerWebSocket } from 'bun'
import type { CardMove, WallCommitRow, WallHostVitals, WallPlanSample, WallPulseRow } from '../../shared/wall'
import type { WsData } from '../handler-context'
import { type SubscriberAuth, subscriberMayReceive } from '../permissions'
import type { ProjectFilter } from './wall-frame'
import { createWallHub, type WallSocket } from './wall-hub'

/** Seed hook, installed at broker startup by `attachWallSources`. Kept mutable
 *  because the hub is a module singleton and the conversation store is not. */
let seedFleet: (() => void) | null = null

export function setWallSeed(fn: (() => void) | null): void {
  seedFleet = fn
}

/**
 * A wall subscriber sees exactly the projects it could already read one
 * conversation at a time. Resolved per flush and memoized for that flush --
 * fifty pulse rows across six projects cost six permission resolves, not fifty.
 * A socket with no grants is an internal/trusted connection and sees all.
 */
function projectFilter(ws: WallSocket): ProjectFilter {
  const auth = ((ws as unknown as { data?: WsData }).data ?? {}) as SubscriberAuth
  if (!auth.grants) return undefined
  const memo = new Map<string, boolean>()
  return project => {
    const hit = memo.get(project)
    if (hit !== undefined) return hit
    const allowed = subscriberMayReceive(auth, project)
    memo.set(project, allowed)
    return allowed
  }
}

function label(ws: WallSocket): string {
  const data = (ws as unknown as { data?: WsData }).data
  return data?.userName ? `dash:${data.userName}` : (data?.wsConnId ?? 'dash')
}

export const wallHub = createWallHub({
  projectFilter,
  label,
  onFirstSubscriber: () => seedFleet?.(),
})

/** Is anyone watching THE WALL right now? Producers check this before doing any
 *  work at all -- building a row for nobody is still work. */
export function wallActive(): boolean {
  return wallHub.subscriberCount() > 0
}

export function publishWallPulse(row: WallPulseRow): void {
  if (!wallActive()) return
  wallHub.state.notePulse(row)
}

export function publishWallPulseGone(conversationId: string): void {
  if (!wallActive()) return
  wallHub.state.notePulseGone(conversationId)
}

export function publishWallCommit(commit: WallCommitRow): void {
  if (!wallActive()) return
  wallHub.state.noteCommit(commit)
}

/**
 * Producer: `board-card-change-events`' `card_changed` relay. Batched because
 * one board write moves several cards and the sentinel sees them in one diff.
 * Arrival order in, so the ring stays oldest-first and the frame builder is the
 * single place that decides the wire's newest-first order.
 */
export function publishWallCardMoves(moves: CardMove[]): void {
  if (!wallActive()) return
  for (const move of moves) wallHub.state.noteCard(move)
}

/** Producer: `wall-host-vitals`. */
export function publishWallHostVitals(vitals: WallHostVitals): void {
  if (!wallActive()) return
  wallHub.state.noteHost(vitals)
}

/** Producer: `wall-plan-usage-series`. */
export function publishWallPlanSample(sample: WallPlanSample): void {
  if (!wallActive()) return
  wallHub.state.notePlan(sample)
}

/** Socket close: the hub is the authority on who is watching, so the close path
 *  must tell it. Idempotent -- an already-unsubscribed socket is a no-op. */
export function dropWallSubscriber(ws: ServerWebSocket<unknown>): void {
  wallHub.unsubscribe(ws as unknown as WallSocket, 'closed')
}
