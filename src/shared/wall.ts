/**
 * THE WALL live channel -- the ONE typed frame the wall surface subscribes to.
 *
 * Ten panes must not mean ten hooks, ten polls and ten reconnects. The broker
 * fans every wall-relevant source into a single accumulator and flushes it at
 * ~2 Hz as a `wall_frame`. Every section is optional: a section is present in a
 * frame only when something in it changed during that window.
 *
 * COALESCE, NEVER QUEUE. Keyed sections (pulse / hosts / plan) hold a Map of
 * latest-value-wins, so a conversation that ticked forty times in one window
 * costs one row. Event sections (commits / cards) are append-with-a-cap: past
 * `WALL_SECTION_CAP` the OLDEST entries are dropped and counted in
 * `WallFrame.dropped`, because a slow client wants the latest state, not a
 * backlog of stale frames.
 *
 * PRODUCERS. `pulse`, `fleet`, `commits` and `cards` are fed by sources that
 * exist today (the conversation store's coalesced update flush, the commit
 * ledger, and `board-card-change-events`' card-ledger ring). `hosts` and `plan`
 * are typed slots with live publish seams on the hub, waiting for the cards
 * that own those producers (`wall-host-vitals`, `wall-plan-usage-series`). The
 * pipe does not care which of them are live.
 */

import type { CardMove } from './protocol'

/** Board lane moves ride the wall as `CardMove`, the shape
 *  `board-card-change-events` already put on the wire. Re-exported so a wall
 *  consumer imports one module, not two. */
export type { CardMove }

/** The subscription channel name. One channel, fleet-wide. */
export const WALL_CHANNEL = 'wall' as const

/**
 * Id slot for the wall subscription in the channel registry. The registry keys
 * every subscription as `${channel}:${id}`; the wall is fleet-wide and has no
 * conversation, so it uses this fixed scope exactly the way `canvas` uses a
 * canvasId. Clients never send it -- the broker supplies it.
 */
export const WALL_SCOPE = 'fleet'

/** ~2 Hz. Fast enough to read as live, slow enough that a 100-conversation
 *  fleet costs two frames a second instead of two hundred. */
export const WALL_FRAME_INTERVAL_MS = 500

/** Per-frame cap on an event-list section (commits, cards). Overflow drops the
 *  oldest and is reported in `WallFrame.dropped`. */
export const WALL_SECTION_CAP = 120

/** Compact per-conversation row -- the pulse pane's whole diet. Deliberately a
 *  projection, not a `ConversationSummary`: the wall reads fifteen fields, not
 *  a hundred, and a detached wall window never subscribes to conversation
 *  channels at all. */
export interface WallPulseRow {
  id: string
  project: string
  title: string
  status: 'active' | 'idle' | 'ended' | 'starting' | 'booting'
  lastActivity: number
  /** Last user impulse, for "waiting on you" vs "waiting on the model". */
  lastInputAt?: number
  costUsd?: number
  /** Context-window pressure, 0-100. */
  contextPct?: number
  /** Sentinel alias (falls back to its id). */
  host?: string
  model?: string
  /** Agent self-reported state text, when it set one. */
  liveStatus?: string
  /** Machine-classified "what is it doing right now". Lower trust. */
  classified?: string
  /** Machine-dispatched (epic seat / nightshift) rather than human-started. */
  managed?: boolean
  /** A hard block is holding it (permission, plan approval, dialog). */
  blocked?: boolean
}

/** Compact commit -- the river's row. No body, no file list: the pane renders a
 *  line, and the full row is one fetch away when someone opens it. */
export interface WallCommitRow {
  hash: string
  shortHash: string
  repoUri: string
  repoName: string
  branch: string
  subject: string
  authorName: string
  insertions: number
  deletions: number
  fileCount: number
  conversationId?: string
  conversationName?: string
  committedAt: number
}

// Card moves are `CardMove` (protocol.ts), produced by
// `board-card-change-events` and remembered in the broker's
// `card-ledger-ring.ts`. THE WALL fans that ring in rather than defining a
// second card-move shape or opening a second subscription for it. The `cards`
// section is NEWEST FIRST in both full and delta frames, matching
// `readCardLedger()` -- a ledger is read from the top.

/**
 * How many CPU samples the broker keeps per node for the sparkline. Shared
 * rather than broker-local because the client renders the array it is handed and
 * must agree on the bound -- a pane that assumed a different length would draw a
 * different time axis than the one the ring actually spans.
 *
 * At the node-stats cadence (5s) this is a five-minute window.
 */
export const WALL_HOST_CPU_SAMPLES = 60

/** One node's vitals sample. Producer: `wall-host-vitals`. */
export interface WallHostVitals {
  nodeId: string
  alias: string
  at: number
  cpuPct?: number
  memPct?: number
  diskPct?: number
  load1?: number
  conversations?: number
  /** Cores the load should be read against. A load of 8 is idle on a 32-core box
   *  and on fire on a 4-core one, so the divisor travels with the number. */
  cores?: number
  /**
   * CPU history, OLDEST FIRST, at most `WALL_HOST_CPU_SAMPLES` long, with the
   * last element equal to `cpuPct`.
   *
   * Carried on EVERY row rather than only on the snapshot. The wall's fan-in map
   * is latest-value-wins, so a history sent once at seed would be overwritten by
   * the next live sample and a subscriber that joined afterwards would get a
   * sparkline of one point. Sixty small numbers every five seconds per node is
   * the cheaper mistake.
   */
  cpuHistory?: number[]
}

/** One profile's plan-utilization sample. Producer: `wall-plan-usage-series`. */
export interface WallPlanSample {
  /** Profile NAME only. The profile-env boundary is not negotiable. */
  profile: string
  node?: string
  /** 0-100. */
  utilization: number
  resetsAt?: number
  at: number
}

/** Fleet-wide counters, summed over the projects this subscriber may read. */
export interface WallFleetCounters {
  conversations: number
  active: number
  idle: number
  blocked: number
  projects: number
  hosts: number
}

/** Keyed sections carry removals alongside changes, so a pane can drop a row
 *  without waiting for a full frame. */
export interface WallPulseSection {
  changed: WallPulseRow[]
  gone?: string[]
}

/**
 * The wire frame. `full: true` is the snapshot the broker sends immediately on
 * subscribe (and after a reconnect resubscribe); every later frame is a delta.
 */
export interface WallFrame {
  type: 'wall_frame'
  /** Per-connection monotonic counter. A gap means a frame was dropped for
   *  backpressure -- the next frame still carries current state, so a gap is
   *  informational, never something the client refetches over. */
  seq: number
  /** Broker wall-clock at flush. */
  at: number
  /** Snapshot rather than delta. */
  full: boolean
  /** How many source events were folded into this frame. 1 means nothing was
   *  coalesced; 40 means the window absorbed 40 updates into one send. */
  coalesced: number
  /** Items discarded by the per-section cap during this window. */
  dropped?: number
  pulse?: WallPulseSection
  commits?: WallCommitRow[]
  cards?: CardMove[]
  hosts?: WallHostVitals[]
  plan?: WallPlanSample[]
  fleet?: WallFleetCounters
}

/** Sections that carry per-project data and therefore need permission filtering
 *  before a frame reaches a given subscriber. */
export const WALL_SCOPED_SECTIONS = ['pulse', 'commits', 'cards'] as const
