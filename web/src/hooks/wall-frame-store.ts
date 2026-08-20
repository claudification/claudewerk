/**
 * THE WALL's client-side fleet picture, folded from `wall_frame` messages.
 *
 * Lives OUTSIDE Zustand (like `token-flow-store.ts` / `thinking-progress-store.ts`)
 * so a 2 Hz frame carrying six sections costs ONE notify, not one per section
 * and not a Zustand update per pane. Consumers read via useSyncExternalStore.
 *
 * A `full: true` frame REPLACES the picture (it is the broker's snapshot on
 * subscribe and after a reconnect resubscribe); every other frame is folded in.
 * Event lists are rings -- the wall shows a river, not an archive.
 */

import type {
  WallCommitRow,
  WallFleetCounters,
  WallFrame,
  WallHostVitals,
  WallPlanSample,
  WallPulseRow,
} from '@shared/wall'
import { flattenPlanSeries, foldPlanSamples, prunePlanSeries, type WallPlanSeries } from '@shared/wall-plan-series'
import { applyCardLedgerFrame } from './card-ledger-feed'
import { createExternalStoreSignal } from './external-store-utils'

/** Client-side ring caps. Generous next to the broker's per-frame cap, small
 *  enough that a wall left open overnight cannot grow without bound. */
const COMMIT_RING = 300

const EMPTY_FLEET: WallFleetCounters = {
  conversations: 0,
  active: 0,
  idle: 0,
  blocked: 0,
  projects: 0,
  hosts: 0,
}

/** Card moves are deliberately absent: they live in `card-ledger-feed.ts`,
 *  which owned that state before the wall existed and still does. This store is
 *  their transport, not their home -- read them with `useLedgerRows()`. */
export interface WallView {
  pulse: WallPulseRow[]
  commits: WallCommitRow[]
  hosts: WallHostVitals[]
  plan: WallPlanSample[]
  fleet: WallFleetCounters
  /** Seq of the last applied frame. */
  seq: number
  /** Broker clock of the last applied frame. */
  at: number
  /** Frames applied since the last full snapshot. */
  frames: number
  /** Frames the broker dropped for backpressure, inferred from seq gaps.
   *  Diagnostic only -- the next frame always carries current state. */
  gaps: number
  /**
   * WHEN THE HISTORY WAS LOST, or null if it never was.
   *
   * The two series the wall draws -- S1's cpu sparklines and S2's 5h plan graph --
   * are ACCUMULATED from frames, so a dropped socket or a restarted broker leaves
   * a real hole: whatever had built up here is discarded on the resubscribe, and
   * whatever the broker's in-memory rings held died with it.
   *
   * A rebuilt series is visually identical to a quiet fleet, which is the whole
   * failure. So the discontinuity is a FACT the surface carries and prints,
   * rather than something a chart quietly draws through. It survives every later
   * frame on purpose: the gap does not heal, it only ages.
   */
  historyLostAt: number | null
}

const EMPTY_VIEW: WallView = {
  pulse: [],
  commits: [],
  hosts: [],
  plan: [],
  fleet: EMPTY_FLEET,
  seq: 0,
  at: 0,
  frames: 0,
  gaps: 0,
  historyLostAt: null,
}

const pulse = new Map<string, WallPulseRow>()
const hosts = new Map<string, WallHostVitals>()
/** Per profile@node, oldest first. A flat FIFO would let one busy profile evict
 *  a quiet one's history and leave S2 drawing a line with a hole in it. Keying,
 *  window and caps are the broker's policy verbatim -- `@shared/wall-plan-series`. */
const planSeries: WallPlanSeries = new Map()
let commits: WallCommitRow[] = []
let plan: WallPlanSample[] = []
let fleet = EMPTY_FLEET
let lastSeq = 0
let frames = 0
let gaps = 0
let historyLostAt: number | null = null

const signal = createExternalStoreSignal()
let view: WallView = EMPTY_VIEW

function ring<T>(prev: T[], added: T[], cap: number): T[] {
  const next = [...prev, ...added]
  return next.length > cap ? next.slice(next.length - cap) : next
}

function rebuildView(frame: WallFrame): void {
  view = {
    pulse: [...pulse.values()],
    commits,
    hosts: [...hosts.values()],
    plan,
    fleet,
    seq: frame.seq,
    at: frame.at,
    frames,
    gaps,
    historyLostAt,
  }
}

function clearPicture(): void {
  pulse.clear()
  hosts.clear()
  planSeries.clear()
  commits = []
  plan = []
  fleet = EMPTY_FLEET
  frames = 0
}

/**
 * THE FRAME'S PAYLOAD SECTIONS -- derived from `WallFrame` rather than listed,
 * so adding a seventh section to the wire is a COMPILE ERROR here until it has
 * a merge in `SECTION_MERGE` below. The envelope fields are the exclusion list.
 *
 * A silently-unmerged section is the exact failure this buys protection from: a
 * frame would arrive carrying it, the fold would ignore it, and the pane reading
 * it would render a permanently empty box that looks like a quiet fleet.
 */
type WallSection = Exclude<keyof WallFrame, 'type' | 'seq' | 'at' | 'full' | 'coalesced' | 'dropped'>

/**
 * One section's merge into the picture.
 *
 * Handed the WHOLE frame, not just its own slot, because two of the six need the
 * envelope: `cards` reads `full` (a full frame REPLACES the ledger, including
 * with nothing) and `plan` reads `at` (the series window is broker-clock-based).
 *
 * EACH MERGE GUARDS ITSELF. That is the point of the map: "is this section worth
 * applying" and "how is it applied" are one section's business, in one place,
 * instead of six `if`s stacked in a caller that then reads as a decision tree.
 */
type SectionMerge = (frame: WallFrame) => void

const SECTION_MERGE: Record<WallSection, SectionMerge> = {
  pulse: f => {
    if (!f.pulse) return
    for (const row of f.pulse.changed) pulse.set(row.id, row)
    for (const id of f.pulse.gone ?? []) pulse.delete(id)
  },

  commits: f => {
    if (!f.commits?.length) return
    commits = ring(commits, f.commits, COMMIT_RING)
  },

  // Card moves belong to `card-ledger-feed.ts`, which owns the P3 ledger's
  // ordering and bound. The wall channel is only its transport now, so the
  // section is handed over rather than mirrored into a second copy here.
  //
  // The `full` arm is NOT redundant with the length check: a full frame carrying
  // no cards means the ledger is genuinely empty, and skipping it would leave
  // yesterday's moves on screen under today's snapshot.
  cards: f => {
    if (!f.full && !f.cards?.length) return
    applyCardLedgerFrame(f.cards ?? [], { full: f.full })
  },

  hosts: f => {
    if (!f.hosts) return
    for (const h of f.hosts) hosts.set(h.nodeId, h)
  },

  plan: f => {
    if (!f.plan?.length) return
    // `minGapMs: 0` -- the broker already decided what is worth keeping. Thinning
    // a second time here would drop points the chart was sent on purpose.
    foldPlanSamples(planSeries, f.plan, f.at, { minGapMs: 0 })
    prunePlanSeries(planSeries, f.at)
    plan = flattenPlanSeries(planSeries)
  },

  fleet: f => {
    if (!f.fleet) return
    fleet = f.fleet
  },
}

/** Fixed application order. `Object.keys` would take it from the literal above,
 *  which makes a reorder-on-edit a silent behaviour change; naming it here means
 *  the order is a decision rather than a side effect of how the map was typed. */
const WALL_SECTIONS = Object.keys(SECTION_MERGE) as WallSection[]

/**
 * Snapshot vs delta, and the gap accounting.
 *
 * A `full` frame replaces the picture, so whatever gap count preceded it is
 * meaningless -- it described a stream that no longer exists.
 */
function noteFrameArrival(frame: WallFrame): void {
  if (frame.full) {
    clearPicture()
    gaps = 0
  } else if (lastSeq > 0 && frame.seq > lastSeq + 1) {
    gaps += frame.seq - lastSeq - 1
  }
  lastSeq = frame.seq
  frames++
}

/**
 * Fold one frame into the picture and notify.
 *
 * A section the wire carries but this client has no merge for is IGNORED, not an
 * error: the loop is driven by the merges this build knows, so an older tab
 * talking to a newer broker draws less of the wall rather than throwing on every
 * frame. The compile-time `Record` above is what stops that being a silent
 * omission for sections added in THIS build.
 */
export function applyWallFrame(frame: WallFrame): void {
  noteFrameArrival(frame)
  for (const section of WALL_SECTIONS) SECTION_MERGE[section](frame)
  rebuildView(frame)
  signal.bump()
}

/** Socket dropped: the broker forgot us, so the picture is now unverified.
 *  Cleared rather than left to rot -- the resubscribe brings a full snapshot. */
export function resetWallFrames(): void {
  // Only a picture that HAD something loses something. A reset before the first
  // frame -- the ordinary first connect -- is not a gap, and reporting one there
  // would put a permanent "history lost" on a wall that never had any.
  if (lastSeq > 0) historyLostAt = Date.now()
  clearPicture()
  // The ledger rides the same frames, so it is just as unverified. Emptying it
  // is honest: the resubscribe's full snapshot repopulates it from the ring.
  applyCardLedgerFrame([], { full: true })
  lastSeq = 0
  gaps = 0
  view = { ...EMPTY_VIEW, historyLostAt }
  signal.bump()
}

/** Test isolation only -- forget that anything was ever lost. */
export function clearWallHistoryGap(): void {
  historyLostAt = null
  view = { ...view, historyLostAt: null }
}

export const subscribe = signal.subscribe
export function getWallView(): WallView {
  return view
}
