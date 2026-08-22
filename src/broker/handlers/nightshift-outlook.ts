/**
 * THE OUTLOOK SCAN -- tonight's list, computed but not run.
 *
 * The Outlook pane used to read `queue_list`, the store the night run stopped
 * using when `scanner-nightshift` moved the input to the `#nightshift` tag. A
 * pane titled "what nightshift will do" that reads a retired store is worse than
 * an empty one: it names five things confidently and none of them will run.
 *
 * The fix is to render the RUN'S OWN ANSWER rather than a second opinion about
 * it, so this module dry-runs the very scanner the orchestrator dispatches from
 * (`nightshiftScanner`, via the contract's self-catching `runScan`). Same
 * selection, same ordering, same caps, same four refusal buckets. There is no
 * second selector to drift.
 *
 * DRY RUN, LITERALLY. The scan reads the board and the conversation registry and
 * writes nothing: no run is opened, no card is untagged, no worker is spawned.
 * The one cost is the scanner's per-admitted-card body read, capped at
 * `totalTasks` -- the same reads the real run does, which is what makes the
 * preview honest about the `unreadable` bucket instead of guessing.
 *
 * ONE BUILDER, TWO PATHS. The deps are wired by `buildNightshiftScanDeps`
 * (`nightshift-board.ts`), which `runNightshift`'s `scanBoardForTasks` also
 * calls -- so neither the selection NOR the wiring can drift. This module owned
 * a second copy of that wiring while `nightshift-orchestrator.ts` was fenced off
 * to another card in the same wave; `nightshift-scan-deps-one-builder` collapsed
 * the two. The only field still built per-caller is `admitted`, which is exactly
 * the field the two paths must disagree about.
 */

import {
  DEFAULT_NIGHTSHIFT_CONFIG,
  type NightshiftConfig,
  type NightshiftQueueItem,
} from '../../shared/nightshift-types'
import type { NightshiftOutlook } from '../../shared/protocol'
import type { CallBoard } from '../board-cards'
import { callBoard } from '../board-rpc'
import type { ConversationStore } from '../conversation-store'
import { buildNightshiftScanDeps } from '../nightshift-board'
import { sendNightshiftOp } from '../nightshift-broker-rpc'
import { type NightshiftScanDeps, nightshiftScanner } from '../scanners/nightshift-scanner'
import { runScan } from '../scanners/scanner'

/** Everything the scan needs, minus the array it fills. Injected so every branch
 *  of this module is exercised without a broker, a sentinel or a board. */
export type OutlookDeps = Omit<NightshiftScanDeps, 'admitted'>

/**
 * Run one scan and shape it for the wire.
 *
 * `runScan` is self-catching, so a board that will not answer comes back as
 * `crashed` and the pane says "the scan failed" instead of rendering an empty
 * list -- an empty list would read as "nothing is tagged", which is the exact
 * class of lie this card exists to end.
 */
export async function nightshiftOutlook(deps: OutlookDeps): Promise<NightshiftOutlook> {
  const admitted: NightshiftQueueItem[] = []
  const report = await runScan(nightshiftScanner, { ...deps, admitted })
  return {
    admitted,
    refused: report.refused.map(r => ({ unit: r.unit, bucket: r.bucket, detail: r.detail })),
    selected: [...report.selected],
    // The scanner's own declared vocabulary, shipped rather than restated, so a
    // new bucket reaches the pane the day it is added.
    buckets: [...nightshiftScanner.buckets],
    totalTasks: deps.totalTasks,
    idleReason: report.idleReason,
    crashed: report.crashed,
  }
}

/** `caps.totalTasks` for a project, defaulted exactly as the run defaults it. A
 *  preview that assumed a different cap would put the wrong cards in `over-cap`. */
async function totalTasksFor(store: ConversationStore, project: string, sendOp: typeof sendNightshiftOp) {
  const res = await sendOp(store, project, { op: 'config_read' })
  const config = (res.config ?? DEFAULT_NIGHTSHIFT_CONFIG) as NightshiftConfig
  const fallback = DEFAULT_NIGHTSHIFT_CONFIG.caps?.totalTasks ?? 8
  return Math.max(1, config.caps?.totalTasks ?? fallback)
}

/** The two side-effecting calls this module makes, behind a swappable seam --
 *  same shape and same reason as `NightshiftIo` (never `mock.module`, which is
 *  process-global and leaks doubles into every later test file). */
export interface OutlookIo {
  callBoard: CallBoard
  sendNightshiftOp: typeof sendNightshiftOp
}

const REAL_IO: OutlookIo = { callBoard, sendNightshiftOp }
let io: OutlookIo = REAL_IO

/** Swap the board/sentinel calls (tests only). `resetNightshiftOutlookIo` restores. */
export function configureNightshiftOutlookIo(next: Partial<OutlookIo>): void {
  io = { ...REAL_IO, ...next }
}

export function resetNightshiftOutlookIo(): void {
  io = REAL_IO
}

/**
 * The real wiring: board + registry + config, for one project.
 *
 * The deps come from `buildNightshiftScanDeps`, the SAME builder
 * `scanBoardForTasks` uses, so the preview cannot be wired differently from the
 * run it previews. What keeps it a dry run is that the builder wires the two
 * READ ops and nothing else -- `untagBoardCard` is not in it, and the run
 * opening/spawning lives entirely in the orchestrator.
 */
export async function outlookForProject(store: ConversationStore, project: string): Promise<NightshiftOutlook> {
  const totalTasks = await totalTasksFor(store, project, io.sendNightshiftOp)
  return nightshiftOutlook(buildNightshiftScanDeps(io.callBoard, store, project, totalTasks))
}

/** The handler's call, behind a seam so the handler test never scans a board. */
export type NightshiftOutlookFn = typeof outlookForProject

let outlookFn: NightshiftOutlookFn = outlookForProject

export function configureNightshiftOutlook(fn: NightshiftOutlookFn): void {
  outlookFn = fn
}

export function resetNightshiftOutlook(): void {
  outlookFn = outlookForProject
}

export function runNightshiftOutlook(store: ConversationStore, project: string): Promise<NightshiftOutlook> {
  return outlookFn(store, project)
}
