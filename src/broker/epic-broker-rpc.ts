/**
 * Broker-internal epic RPCs. The executor needs the run, the baton and the board
 * -- all sentinel-owned files -- plus the lease CAS. Thin over
 * `broker-sentinel-rpc.ts`; only the epic-shaped helpers live here.
 */

import type { EpicLease } from '../shared/epic-lease'
import { acknowledgedCardIds } from '../shared/epic-log'
import type { EpicLogEntry } from '../shared/epic-run-types'
import type { ProjectTaskMeta } from '../shared/project-task-types'
import type {
  EpicBatonQuery,
  EpicLeaseInput,
  EpicLogAppendInput,
  EpicOpKind,
  EpicResult,
  EpicRunPatchInput,
  EpicRunSnapshot,
  ProjectBoardResult,
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

export interface EpicOpInput {
  op: EpicOpKind
  epicId: string
  start?: Record<string, unknown>
  patch?: EpicRunPatchInput
  logAppend?: EpicLogAppendInput
  lease?: EpicLeaseInput
  baton?: EpicBatonQuery
  reason?: string
}

export function sendEpicOp(deps: SentinelRpcDeps, project: string, op: EpicOpInput): Promise<EpicResult> {
  return sendSentinelOp(EPIC_SPEC, deps, project, op)
}

/** The board, for `planEpic`. A read the epic engine cannot answer for itself:
 *  children declare their parent, so the whole card list is the cheapest question. */
export async function fetchBoardCards(deps: SentinelRpcDeps, project: string): Promise<ProjectTaskMeta[]> {
  const res = await sendSentinelOp<ProjectBoardResult>(BOARD_SPEC, deps, project, { op: 'list' })
  return res.ok && res.tasks ? res.tasks : []
}

export interface EpicRunView {
  run: EpicRunSnapshot | null
  /** The PROMPT-SIZED tail. What a fresh overseer generation is handed, and the
   *  only thing it is for -- never ask it what has been acknowledged. */
  baton: EpicLogEntry[]
  /** Every card acknowledged anywhere in the log. The wake's standing question. */
  acknowledgedCardIds: string[]
  /** Who holds the overseer seat, off the epic card. `null` = never run. */
  lease: EpicLease | null
  error?: string
}

const EMPTY_VIEW = (error: string): EpicRunView => ({
  run: null,
  baton: [],
  acknowledgedCardIds: [],
  lease: null,
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
 * been acknowledged", which would re-wake an overseer for every settled card in
 * the epic on every sweep.
 */
export function toEpicRunView(res: EpicResult): EpicRunView {
  if (!res.ok) return EMPTY_VIEW(res.error ?? 'epic get failed')
  const baton = res.baton ?? []
  return {
    run: res.run ?? null,
    baton,
    acknowledgedCardIds: res.acknowledgedCardIds ?? acknowledgedCardIds(baton),
    lease: res.currentLease ?? null,
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
