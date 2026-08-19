/**
 * THE WALL's fan-in state: the authoritative fleet picture plus the dirty set
 * accumulated since the last flush.
 *
 * COALESCE, NEVER QUEUE. Keyed sections keep a Map of latest-value-wins, so a
 * conversation that ticks forty times inside one 500 ms window costs exactly
 * one row on the wire. Event sections (commits, card moves) are rings: past the
 * cap the OLDEST entries fall off and are counted, because a slow client wants
 * the current river, not a backlog.
 *
 * `plan` is the ONE exception and it is deliberate: S2 draws a five-hour SHAPE,
 * so its section is a bounded per-key SERIES rather than a latest value. See
 * `notePlan`. The thinning that keeps it small happens at the producer
 * (`plan-usage-series.ts`), not here.
 *
 * Pure: no sockets, no timers, no permissions. The hub owns those.
 */

import {
  type CardMove,
  WALL_SECTION_CAP,
  type WallCommitRow,
  type WallFleetCounters,
  type WallHostVitals,
  type WallPlanSample,
  type WallPulseRow,
} from '../../shared/wall'
import { appendPlanSample, flattenPlanSeries, type WallPlanSeries } from '../../shared/wall-plan-series'
import { computeCounters } from './wall-counters'

/** How many commits / card moves the snapshot keeps for a fresh subscriber. */
const RING_CAP = WALL_SECTION_CAP

/** Everything that changed since the last drain. Sections absent when clean. */
export interface WallDelta {
  pulseChanged: WallPulseRow[]
  pulseGone: string[]
  commits: WallCommitRow[]
  cards: CardMove[]
  hosts: WallHostVitals[]
  plan: WallPlanSample[]
  fleetDirty: boolean
  /** Source events folded into this window. */
  coalesced: number
  /** Items the caps discarded during this window. */
  dropped: number
}

export interface WallSnapshot {
  pulse: WallPulseRow[]
  commits: WallCommitRow[]
  cards: CardMove[]
  hosts: WallHostVitals[]
  plan: WallPlanSample[]
}

function pushRing<T>(ring: T[], item: T): number {
  ring.push(item)
  if (ring.length <= RING_CAP) return 0
  const over = ring.length - RING_CAP
  ring.splice(0, over)
  return over
}

export interface WallState {
  notePulse: (row: WallPulseRow) => void
  notePulseGone: (id: string) => void
  noteCommit: (commit: WallCommitRow) => void
  noteCard: (move: CardMove) => void
  noteHost: (vitals: WallHostVitals) => void
  notePlan: (sample: WallPlanSample) => void
  /** Anything pending for the next frame? */
  isDirty: () => boolean
  /** Take the pending delta and reset the dirty set. */
  drain: () => WallDelta
  /** Full current picture, for a fresh subscriber's `full: true` frame. */
  snapshot: () => WallSnapshot
  /** Counters over the given projects (undefined = every project). */
  countersFor: (allowed?: (project: string) => boolean) => WallFleetCounters
  /** Test isolation. */
  reset: () => void
}

export function createWallState(): WallState {
  const pulse = new Map<string, WallPulseRow>()
  const hosts = new Map<string, WallHostVitals>()
  const plan: WallPlanSeries = new Map()
  const commitRing: WallCommitRow[] = []
  const cardRing: CardMove[] = []

  let dirtyPulse = new Set<string>()
  let gonePulse = new Set<string>()
  let pendingCommits: WallCommitRow[] = []
  let pendingCards: CardMove[] = []
  let dirtyHosts = new Set<string>()
  let pendingPlan: WallPlanSample[] = []
  let fleetDirty = false
  let coalesced = 0
  let dropped = 0

  function notePulse(row: WallPulseRow): void {
    const prev = pulse.get(row.id)
    pulse.set(row.id, row)
    dirtyPulse.add(row.id)
    gonePulse.delete(row.id)
    coalesced++
    if (!prev || prev.project !== row.project || prev.status !== row.status || prev.blocked !== row.blocked) {
      fleetDirty = true
    }
  }

  function notePulseGone(id: string): void {
    if (!pulse.delete(id)) return
    dirtyPulse.delete(id)
    gonePulse.add(id)
    fleetDirty = true
    coalesced++
  }

  function noteCommit(commit: WallCommitRow): void {
    dropped += pushRing(pendingCommits, commit)
    pushRing(commitRing, commit)
    coalesced++
  }

  function noteCard(move: CardMove): void {
    dropped += pushRing(pendingCards, move)
    pushRing(cardRing, move)
    coalesced++
  }

  function noteHost(vitals: WallHostVitals): void {
    hosts.set(vitals.nodeId, vitals)
    dirtyHosts.add(vitals.nodeId)
    coalesced++
  }

  /**
   * The ONE section that is not latest-value-wins. S2 draws the SHAPE of the
   * last five hours, so a fresh subscriber's snapshot has to carry the series,
   * not the newest point of it -- a keyed Map would collapse the seed replay to
   * one dot per profile and the pane would have to interpolate to look like a
   * chart. The thinning that keeps this bounded happened upstream in
   * `plan-usage-series.ts`; the same append is applied here so a producer that
   * ignored it still cannot grow this without bound.
   */
  function notePlan(sample: WallPlanSample): void {
    if (!appendPlanSample(plan, sample, sample.at, { minGapMs: 0 })) return
    pendingPlan.push(sample)
    coalesced++
  }

  function isDirty(): boolean {
    return (
      dirtyPulse.size > 0 ||
      gonePulse.size > 0 ||
      pendingCommits.length > 0 ||
      pendingCards.length > 0 ||
      dirtyHosts.size > 0 ||
      pendingPlan.length > 0 ||
      fleetDirty
    )
  }

  function drain(): WallDelta {
    const delta: WallDelta = {
      pulseChanged: [...dirtyPulse].map(id => pulse.get(id)).filter((r): r is WallPulseRow => r !== undefined),
      pulseGone: [...gonePulse],
      commits: pendingCommits,
      cards: pendingCards,
      hosts: [...dirtyHosts].map(id => hosts.get(id)).filter((h): h is WallHostVitals => h !== undefined),
      plan: pendingPlan,
      fleetDirty,
      coalesced,
      dropped,
    }
    dirtyPulse = new Set()
    gonePulse = new Set()
    pendingCommits = []
    pendingCards = []
    dirtyHosts = new Set()
    pendingPlan = []
    fleetDirty = false
    coalesced = 0
    dropped = 0
    return delta
  }

  function snapshot(): WallSnapshot {
    return {
      pulse: [...pulse.values()],
      commits: [...commitRing],
      cards: [...cardRing],
      hosts: [...hosts.values()],
      plan: flattenPlanSeries(plan),
    }
  }

  function countersFor(allowed?: (project: string) => boolean): WallFleetCounters {
    return computeCounters(pulse.values(), allowed)
  }

  function reset(): void {
    pulse.clear()
    hosts.clear()
    plan.clear()
    commitRing.length = 0
    cardRing.length = 0
    drain()
  }

  return {
    notePulse,
    notePulseGone,
    noteCommit,
    noteCard,
    noteHost,
    notePlan,
    isDirty,
    drain,
    snapshot,
    countersFor,
    reset,
  }
}
