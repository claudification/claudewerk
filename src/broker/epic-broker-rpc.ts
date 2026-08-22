/**
 * Broker-internal epic RPCs. The executor needs the run, the baton and the board
 * -- all sentinel-owned files -- plus the lease CAS. Thin over
 * `broker-sentinel-rpc.ts`; only the epic-shaped helpers live here.
 */

import type { EpicLease } from '../shared/epic-lease'
import { acknowledgedCardIds, dispatchCountsByCard } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import { parseWhen } from '../shared/epic-when'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type {
  EpicBatonQuery,
  EpicLeaseInput,
  EpicLogAppendInput,
  EpicOpKind,
  EpicResult,
  EpicRunPatchInput,
  EpicRunSnapshot,
  EpicSeatInput,
  ProjectBoardResult,
  ProjectReadFileResult,
  ProjectWriteFileResult,
} from '../shared/protocol'
import { type SentinelRpcDeps, sendSentinelOp } from './broker-sentinel-rpc'

const EPIC_SPEC = {
  opType: 'epic_op',
  idPrefix: 'epic',
  fail: (requestId: string, error: string): EpicResult => ({
    type: 'epic_result',
    requestId,
    op: 'get' as EpicOpKind,
    ok: false,
    error,
  }),
}

const BOARD_SPEC = {
  opType: 'project_board_op',
  idPrefix: 'epic-board',
  fail: (requestId: string, error: string): ProjectBoardResult => ({
    type: 'project_board_result',
    requestId,
    op: 'list',
    ok: false,
    error,
  }),
}

/**
 * RAW CARD TEXT, both ways. The board's own `update` op is not an option here
 * and the reason is a live bug, not a preference: every write through
 * `serializeCard` round-trips the front matter through `parseFrontmatter`, which
 * is deliberately flat, so a nested `promise:` block comes back as top-level
 * keys with `closes:` emptied (filed as
 * `werk-promise-ledger-card-writer-flattens`, pinned by a test in
 * promise-ledger.test.ts). The promise ledger writes by LINE SURGERY, and line
 * surgery needs the bytes.
 *
 * Still not the broker touching a filesystem: `projectRoot` is filled in by
 * `sendSentinelOp` from the project URI and the SENTINEL resolves and jails it
 * (src/shared/project-store.ts). The broker sends a project-relative path and
 * never learns where it landed.
 */
const READ_FILE_SPEC = {
  opType: 'project_read_file',
  idPrefix: 'epic-read',
  fail: (requestId: string, error: string): ProjectReadFileResult => ({
    type: 'project_read_file_result',
    requestId,
    ok: false,
    error,
  }),
}

const WRITE_FILE_SPEC = {
  opType: 'project_write_file',
  idPrefix: 'epic-write',
  fail: (requestId: string, error: string): ProjectWriteFileResult => ({
    type: 'project_write_file_result',
    requestId,
    ok: false,
    error,
  }),
}

/** A card's raw markdown. `maxBytes` is deliberately generous -- a TRUNCATED
 *  read that got written back would delete the tail of somebody's card, so the
 *  caller must refuse on `truncated` rather than trim the cap here. */
export function readProjectFile(
  deps: SentinelRpcDeps,
  project: string,
  relPath: string,
  maxBytes: number,
): Promise<ProjectReadFileResult> {
  return sendSentinelOp(READ_FILE_SPEC, deps, project, { relPath, maxBytes })
}

export function writeProjectFile(
  deps: SentinelRpcDeps,
  project: string,
  relPath: string,
  content: string,
): Promise<ProjectWriteFileResult> {
  return sendSentinelOp(WRITE_FILE_SPEC, deps, project, { relPath, content })
}

export interface EpicOpInput {
  op: EpicOpKind
  epicId: string
  start?: Record<string, unknown>
  patch?: EpicRunPatchInput
  logAppend?: EpicLogAppendInput
  lease?: EpicLeaseInput
  /** The per-card seat mutex -- `seat_get` / `seat_claim` / `seat_release`. */
  seat?: EpicSeatInput
  baton?: EpicBatonQuery
  reason?: string
}

export function sendEpicOp(deps: SentinelRpcDeps, project: string, op: EpicOpInput): Promise<EpicResult> {
  return sendSentinelOp(EPIC_SPEC, deps, project, op)
}

/**
 * THE BOARD READ, WITH ITS FAILURE INTACT.
 *
 * `ok: false` and `cards: []` are NOT the same fact, and collapsing them is what
 * made an inspect announce `no epic on the board (no card carries it and no card
 * claims it as a parent)` about an epic with 31 children on disk, in the same
 * payload that said the sentinel had timed out. "No children" is a statement a
 * werk-master can act on, and the action it justifies is aborting the run.
 *
 * `cards` is still `[]` on a failure so a caller that only wants the list keeps a
 * safe shape -- but the failure is there to be read, and EVERY caller reads it.
 *
 * THERE IS NO LONGER A SPELLING THAT SWALLOWS IT. `fetchBoardCards` returned the
 * list alone and existed for the two callers that already did; the second of them
 * turned out to be the epic executor, where a swallowed failure was not a
 * rendering bug but a run PARKED by a sentinel timeout
 * (`werk-beat-acts-on-an-unread-board`). Both callers now read the failure, so the
 * convenience wrapper is gone rather than left as a trap for the third.
 */
export interface EpicBoardRead {
  ok: boolean
  cards: ProjectTaskMeta[]
  /** Set only when `ok` is false. The sentinel's own words. */
  error?: string
}

export async function fetchBoardRead(deps: SentinelRpcDeps, project: string): Promise<EpicBoardRead> {
  const res = await sendSentinelOp<ProjectBoardResult>(BOARD_SPEC, deps, project, { op: 'list' })
  if (!res.ok) return { ok: false, cards: [], error: res.error ?? 'board list failed' }
  return { ok: true, cards: res.tasks ?? [] }
}

export interface EpicRunView {
  run: EpicRunSnapshot | null
  /** The PROMPT-SIZED tail. What a fresh werk-master generation is handed, and the
   *  only thing it is for -- never ask it what has been acknowledged. */
  baton: EpicLogEntry[]
  /** Every card acknowledged anywhere in the log. The wake's standing question. */
  acknowledgedCardIds: string[]
  /** cardId -> seats dispatched for it anywhere in the log. The ceiling on the
   *  redispatch path -- see `EpicResult.dispatchCounts` and `MAX_CARD_SEATS`. */
  dispatchCounts: Record<string, number>
  /** Who holds the werk-master seat, off the epic card. `null` = never run. */
  lease: EpicLease | null
  /**
   * THE CLOCK THE LEASE ABOVE WAS STAMPED WITH, epoch ms -- see
   * `EpicResult.clockMs`.
   *
   * ABSENT OR `null` MEANS NO READING, which reads as "apply no correction", i.e.
   * the two-clock subtraction the beat did before this existed. Optional rather
   * than required for the reason `queue`, `headroom` and `producedOutput` are: a
   * caller that hand-builds a view -- every test in this repo that drives one beat
   * -- keeps today's arithmetic instead of asserting an offset it never measured.
   */
  sentinelClockMs?: number | null
  error?: string
}

/**
 * THE `when` AXIS, NORMALISED AT THE SEAM -- version skew, not a default.
 *
 * Broker and sentinel ship separately, and a sentinel running the older bundle
 * reads `cadence` through a scalar `pick()`: its `get` answers with a bare
 * string, which is what this field was for the whole life of the feature. Every
 * broker reader downstream expects the list, and the one that would notice last
 * is the control panel, where `.join` on a string is a crash rather than a wrong
 * answer.
 *
 * So the shape is fixed HERE, at the one place a sentinel reply becomes a broker
 * fact, instead of at each of the five places that read it.
 */
export function normalizeWhen(run: EpicRunSnapshot | null): EpicRunSnapshot | null {
  return run ? { ...run, cadence: parseWhen(run.cadence) } : null
}

const EMPTY_VIEW = (error: string): EpicRunView => ({
  run: null,
  baton: [],
  acknowledgedCardIds: [],
  dispatchCounts: {},
  lease: null,
  sentinelClockMs: null,
  error,
})

/**
 * One `get` result, folded into the view the engine consumes. Its own exported
 * function so a test can drive the REAL sentinel handler through the REAL broker
 * fold: the interesting epic bugs live in the shape of this answer, and a test
 * that re-implements the mapping cannot catch one.
 *
 * The `??` on `acknowledgedCardIds` is VERSION SKEW, not a default. Broker and
 * sentinel ship separately, so a new broker will meet an old sentinel that does
 * not send the field. Folding the tail then is the old behaviour -- wrong for
 * long runs, but it degrades to the bug we had rather than to "nothing has ever
 * been acknowledged", which would re-wake a werk-master for every settled card in
 * the epic on every sweep.
 */
export function toEpicRunView(res: EpicResult): EpicRunView {
  if (!res.ok) return EMPTY_VIEW(res.error ?? 'epic get failed')
  const baton = res.baton ?? []
  return {
    run: normalizeWhen(res.run ?? null),
    baton,
    acknowledgedCardIds: res.acknowledgedCardIds ?? acknowledgedCardIds(baton),
    // Same skew rule, same direction of error: an old sentinel makes the ceiling
    // read LOW, which spends a seat it should have withheld -- survivable. The
    // opposite fallback (pretend the ceiling is hit) would strand every bounced
    // card on the board the moment a deploy went out of order.
    dispatchCounts: res.dispatchCounts ?? dispatchCountsByCard(baton),
    lease: res.currentLease ?? null,
    // Same skew rule again, and the safe direction is `null`: no reading means no
    // correction, which is the two-clock subtraction the beat has always done,
    // rather than an offset of zero asserted as a measurement.
    sentinelClockMs: typeof res.clockMs === 'number' && Number.isFinite(res.clockMs) ? res.clockMs : null,
  }
}

/**
 * Run + lease + baton in one call -- what a beat reads before deciding anything,
 * and what an inspect reads to explain the run.
 *
 * `baton` shapes the slice. A beat omits it and takes the prompt-sized default;
 * a debugging caller asks for depth or a filter.
 */
export async function fetchEpicRun(
  deps: SentinelRpcDeps,
  project: string,
  epicId: string,
  baton?: EpicBatonQuery,
): Promise<EpicRunView> {
  return toEpicRunView(await sendEpicOp(deps, project, { op: 'get', epicId, ...(baton ? { baton } : {}) }))
}

/** Append one baton entry. Failures are logged by the caller, never thrown -- a
 *  baton write that fails must not take the sweep down with it. */
export function appendBaton(
  deps: SentinelRpcDeps,
  project: string,
  epicId: string,
  logAppend: EpicLogAppendInput,
): Promise<EpicResult> {
  return sendEpicOp(deps, project, { op: 'log_append', epicId, logAppend })
}
