/**
 * Turning wall state into the wire frame for ONE subscriber.
 *
 * Every project-scoped section is filtered through that subscriber's own
 * `allowed(project)` predicate before it leaves the broker -- a wall subscriber
 * sees exactly the projects it could already read one conversation at a time.
 * Unscoped sections (host vitals, plan usage) are node/profile facts, not
 * project facts, and are gated at SUBSCRIBE time instead.
 *
 * A delta that filters down to nothing returns null: no empty frames on the
 * wire, so `wall_frame` arriving always means something actually moved.
 */

import type { WallFleetCounters, WallFrame } from '../../shared/wall'
import type { WallDelta, WallSnapshot, WallState } from './wall-state'

/** Which projects may this subscriber see? `undefined` = all of them. */
export type ProjectFilter = ((project: string) => boolean) | undefined

function nonEmpty<T>(items: T[]): T[] | undefined {
  return items.length > 0 ? items : undefined
}

/**
 * `fleet` is passed in already decided rather than derived here: the counters
 * are per-subscriber (they only sum the projects that subscriber may read), and
 * a fleet change in a project it cannot see must not manufacture a frame
 * carrying numbers identical to the ones it already has.
 */
export function deltaToFrame(
  delta: WallDelta,
  allowed: ProjectFilter,
  seq: number,
  at: number,
  fleet?: WallFleetCounters,
): WallFrame | null {
  const changed = allowed ? delta.pulseChanged.filter(r => allowed(r.project)) : delta.pulseChanged
  const commits = allowed ? delta.commits.filter(c => allowed(c.repoUri)) : delta.commits
  const cards = allowed ? delta.cards.filter(c => allowed(c.project)) : delta.cards

  // `gone` ids carry no project (the row is already deleted upstream), so they
  // are forwarded unfiltered. An id the subscriber never received is a no-op on
  // the client, and an id it did receive it was already permitted to see.
  const gone = nonEmpty(delta.pulseGone)
  const pulse = changed.length > 0 || gone ? { changed, ...(gone ? { gone } : {}) } : undefined

  const frame: WallFrame = {
    type: 'wall_frame',
    seq,
    at,
    full: false,
    coalesced: delta.coalesced,
    ...(delta.dropped > 0 ? { dropped: delta.dropped } : {}),
    ...(pulse ? { pulse } : {}),
    ...(commits.length > 0 ? { commits } : {}),
    ...(cards.length > 0 ? { cards } : {}),
    ...(delta.hosts.length > 0 ? { hosts: delta.hosts } : {}),
    ...(delta.plan.length > 0 ? { plan: delta.plan } : {}),
    ...(fleet ? { fleet } : {}),
  }

  const hasPayload =
    frame.pulse !== undefined ||
    frame.commits !== undefined ||
    frame.cards !== undefined ||
    frame.hosts !== undefined ||
    frame.plan !== undefined ||
    frame.fleet !== undefined
  return hasPayload ? frame : null
}

export function snapshotToFrame(
  snap: WallSnapshot,
  state: WallState,
  allowed: ProjectFilter,
  seq: number,
  at: number,
): WallFrame {
  return {
    type: 'wall_frame',
    seq,
    at,
    full: true,
    coalesced: 1,
    pulse: { changed: allowed ? snap.pulse.filter(r => allowed(r.project)) : snap.pulse },
    commits: allowed ? snap.commits.filter(c => allowed(c.repoUri)) : snap.commits,
    cards: allowed ? snap.cards.filter(c => allowed(c.project)) : snap.cards,
    hosts: snap.hosts,
    plan: snap.plan,
    fleet: state.countersFor(allowed),
  }
}
