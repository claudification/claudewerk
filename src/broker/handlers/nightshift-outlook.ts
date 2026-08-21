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
 * WHY THE WIRING IS HERE AND NOT SHARED WITH THE ORCHESTRATOR. `runNightshift`
 * builds the same deps in `scanBoardForTasks`, and one builder would be better
 * than two. `nightshift-orchestrator.ts` belongs to another card in this wave
 * (consume, never reshape), so the extraction is filed as its own card --
 * `nightshift-scan-deps-one-builder` -- rather than taken here. The thing that
 * MUST NOT be duplicated, the selection itself, is not: both paths call
 * `runScan(nightshiftScanner, ...)`.
 */

import {
  DEFAULT_NIGHTSHIFT_CONFIG,
  type NightshiftConfig,
  type NightshiftQueueItem,
} from '../../shared/nightshift-types'
import type { Conversation, NightshiftOutlook } from '../../shared/protocol'
import { callBoard } from '../board-rpc'
import type { ConversationStore } from '../conversation-store'
import { type CallBoard, listBoardCards, readBoardCard } from '../nightshift-board'
import { sendNightshiftOp } from '../nightshift-broker-rpc'
import { type NightshiftScanDeps, nightshiftScanner } from '../scanners/nightshift-scanner'
import { runScan } from '../scanners/scanner'
import { werkLiveness } from '../werk-liveness'

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

/** The registry reads the scan needs. Structural, so a test hands over a plain
 *  object rather than a whole ConversationStore. */
interface ScanStore {
  getAllConversations: () => Conversation[]
  getActiveConversationCount: (id: string) => number
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

/** The real wiring: board + registry + config, for one project. */
export async function outlookForProject(store: ConversationStore, project: string): Promise<NightshiftOutlook> {
  const s = store as unknown as ScanStore
  const totalTasks = await totalTasksFor(store, project, io.sendNightshiftOp)
  return nightshiftOutlook({
    getAllConversations: s.getAllConversations,
    isLive: werkLiveness(s.getActiveConversationCount),
    log: line => console.log(line),
    now: () => Date.now(),
    project,
    listCards: () => listBoardCards(io.callBoard, store, project),
    readCard: slug => readBoardCard(io.callBoard, store, project, slug),
    totalTasks,
  })
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
