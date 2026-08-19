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
  WallCardMove,
  WallCommitRow,
  WallFleetCounters,
  WallFrame,
  WallHostVitals,
  WallPlanSample,
  WallPulseRow,
} from '@shared/wall'
import { createExternalStoreSignal } from './external-store-utils'

/** Client-side ring caps. Generous next to the broker's per-frame cap, small
 *  enough that a wall left open overnight cannot grow without bound. */
const COMMIT_RING = 300
const CARD_RING = 300
const PLAN_RING = 600

const EMPTY_FLEET: WallFleetCounters = {
  conversations: 0,
  active: 0,
  idle: 0,
  blocked: 0,
  projects: 0,
  hosts: 0,
}

export interface WallView {
  pulse: WallPulseRow[]
  commits: WallCommitRow[]
  cards: WallCardMove[]
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
}

const EMPTY_VIEW: WallView = {
  pulse: [],
  commits: [],
  cards: [],
  hosts: [],
  plan: [],
  fleet: EMPTY_FLEET,
  seq: 0,
  at: 0,
  frames: 0,
  gaps: 0,
}

const pulse = new Map<string, WallPulseRow>()
const hosts = new Map<string, WallHostVitals>()
let commits: WallCommitRow[] = []
let cards: WallCardMove[] = []
let plan: WallPlanSample[] = []
let fleet = EMPTY_FLEET
let lastSeq = 0
let frames = 0
let gaps = 0

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
    cards,
    hosts: [...hosts.values()],
    plan,
    fleet,
    seq: frame.seq,
    at: frame.at,
    frames,
    gaps,
  }
}

function clearPicture(): void {
  pulse.clear()
  hosts.clear()
  commits = []
  cards = []
  plan = []
  fleet = EMPTY_FLEET
  frames = 0
}

/** Fold one frame into the picture and notify. */
export function applyWallFrame(frame: WallFrame): void {
  if (frame.full) {
    clearPicture()
    gaps = 0
  } else if (lastSeq > 0 && frame.seq > lastSeq + 1) {
    gaps += frame.seq - lastSeq - 1
  }
  lastSeq = frame.seq
  frames++

  if (frame.pulse) {
    for (const row of frame.pulse.changed) pulse.set(row.id, row)
    for (const id of frame.pulse.gone ?? []) pulse.delete(id)
  }
  if (frame.commits?.length) commits = ring(commits, frame.commits, COMMIT_RING)
  if (frame.cards?.length) cards = ring(cards, frame.cards, CARD_RING)
  if (frame.hosts) for (const h of frame.hosts) hosts.set(h.nodeId, h)
  if (frame.plan?.length) plan = ring(plan, frame.plan, PLAN_RING)
  if (frame.fleet) fleet = frame.fleet

  rebuildView(frame)
  signal.bump()
}

/** Socket dropped: the broker forgot us, so the picture is now unverified.
 *  Cleared rather than left to rot -- the resubscribe brings a full snapshot. */
export function resetWallFrames(): void {
  clearPicture()
  lastSeq = 0
  gaps = 0
  view = EMPTY_VIEW
  signal.bump()
}

export const subscribe = signal.subscribe
export function getWallView(): WallView {
  return view
}
