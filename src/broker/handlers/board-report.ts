/**
 * THE MORNING REPORT'S TWO VERBS -- read the brew, execute what is ticked.
 *
 * WHY THIS IS NOT THE BOARD RELAY NEXT DOOR. `handlers/project.ts` forwards a
 * board op to the sentinel verbatim, which is right for CRUD and wrong for these
 * two:
 *
 *  - `latest` MUST NOT REACH THE SENTINEL AT ALL. The surface is a pure reader:
 *    opening it renders the artifact the schedule already produced. A panel that
 *    sweeps on open can never visibly fail, and the missing brew is the only
 *    liveness signal this feature has. So `latest` is answered from the broker's
 *    own sidecar and cannot, by construction, start a sweep.
 *
 *  - `execute` is THREE acts in a fixed order, and the order is the whole point:
 *    log the intent, perform the write, log what the write actually did. Doing
 *    that in the browser would mean a closed tab loses the record of a mutation
 *    that already happened. Doing it in the generic relay would mean every board
 *    op paid for it. So it lives here, server-side, once.
 *
 * THE ORDERING RULE. Nothing in this file writes an outcome from an intent. The
 * `apply` op returns one outcome per proposal, read back off disk by the process
 * that owns the files; those rows are what get logged. A failed card write that
 * leaves a log reading "moved" is the exact class of confident-but-untrue record
 * the promise ledger exists to prevent, and a single boolean over the batch would
 * produce one every time a neighbour failed.
 */

import type { BoardApplyOutcome, BoardProposalRef, BoardReportRecord, BoardReportRequest } from '../../shared/protocol'
import { latestBoardReport, recordBoardIntent, recordBoardOutcome } from '../board-audit'
import { callBoard } from '../board-rpc'
import type { HandlerContext, MessageHandler } from '../handler-context'
import { CONTROL_PANEL_ONLY, registerHandlers } from '../message-router'

/** Key a proposal by identity, so a ticked row can be matched to the report it
 *  claims to come from. `other` is deliberately NOT in the key: it is data the
 *  sweep computed, and a surface that changed it is answered by the report's
 *  copy rather than by its own. */
function proposalKey(p: { kind: string; card: string }): string {
  return `${p.kind} ${p.card}`
}

let traceSeq = 0
function nextTraceId(): string {
  traceSeq += 1
  return `board-exec-${traceSeq}-${Date.now()}`
}

function reply(ctx: HandlerContext, requestId: string, body: Record<string, unknown>): void {
  ctx.reply({ type: 'board_report_result', requestId, ...body })
}

/** `latest` -- read only, and it stops at the broker. */
function handleLatest(ctx: HandlerContext, d: BoardReportRequest): void {
  ctx.requirePermission('files:read', d.project)
  reply(ctx, d.requestId, { ok: true, report: latestBoardReport(d.project) })
}

/**
 * Every ticked row, replaced by the copy the REPORT holds.
 *
 * A ref that names a (kind, card) the report never proposed is not a partial
 * problem to route around: the tick list and the report disagree about what was
 * on offer, and applying the overlap would execute a request nobody made. So the
 * whole press is refused, before any write.
 */
function authorise(
  proposals: readonly BoardProposalRef[],
  report: { proposals: readonly { kind: string; card: string; other?: string }[] },
): { ok: true; refs: BoardProposalRef[] } | { ok: false; error: string } {
  const known = new Map(report.proposals.map(p => [proposalKey(p), p]))
  const refs: BoardProposalRef[] = []
  for (const ref of proposals) {
    const hit = known.get(proposalKey(ref))
    if (!hit) return { ok: false, error: `\`${ref.card}\` has no \`${ref.kind}\` proposal in this report` }
    // The report's own `other`, never the caller's: `duplicate-of:<id>` is a
    // pointer the sweep computed and the surface only renders.
    refs.push(hit.other === undefined ? { kind: ref.kind, card: ref.card } : { ...ref, other: hit.other })
  }
  return { ok: true, refs }
}

/**
 * One outcome per proposal when `apply` never came back.
 *
 * The intent rows are already written, so the ledger has to be CLOSED rather
 * than left open: an intent with no outcome beside it reads as "still running"
 * forever. Every row says `ok: false` and carries the transport error, which is
 * the truth -- nothing was read back off disk, so nothing may claim to have
 * moved.
 */
function failedOutcomes(refs: readonly BoardProposalRef[], error: string): BoardApplyOutcome[] {
  return refs.map(r => ({ kind: r.kind, card: r.card, ok: false, error }))
}

/**
 * Everything that has to be true before a single card is touched.
 *
 * Kept apart from the ordering below so the three acts (intent, write, outcome)
 * read as three lines rather than as the tail of a validation funnel. Every
 * refusal here happens with nothing written and nothing logged.
 */
function vet(
  project: string,
  wanted: BoardReportRequest['execute'],
): { ok: true; report: BoardReportRecord; refs: BoardProposalRef[] } | { ok: false; error: string } {
  if (!wanted || wanted.proposals.length === 0) return { ok: false, error: 'nothing was ticked' }

  const report = latestBoardReport(project)
  if (!report) return { ok: false, error: 'no morning report has been recorded for this project' }

  // A tick list computed against an older board is refused rather than applied
  // to today's. The surface re-reads and the human looks again -- which is the
  // cheap half of the trade, against archiving a card the newer sweep would not
  // have proposed.
  if (wanted.date !== report.date) {
    return {
      ok: false,
      error: `this report is no longer current (you executed ${wanted.date}, the latest is ${report.date})`,
    }
  }

  const authorised = authorise(wanted.proposals, report)
  return authorised.ok ? { ok: true, report, refs: authorised.refs } : authorised
}

/**
 * THE WRITE. Returns the outcomes to log, and the transport error if there are
 * none to be had.
 *
 * `note-delete-at` is forwarded rather than filtered: the op refuses it at the
 * sentinel (F18, keyed on kind and not on a checkbox), and a second, weaker gate
 * here would be the one that drifts. The refusal then comes back as a real
 * outcome from the process that owns the files.
 */
async function performApply(
  ctx: HandlerContext,
  project: string,
  report: BoardReportRecord,
  refs: BoardProposalRef[],
): Promise<{ outcomes: BoardApplyOutcome[]; transportError: string | null }> {
  const result = await callBoard(ctx.conversations, project, {
    op: 'apply',
    project,
    apply: { proposals: refs, tz: report.tz, reportDate: report.date },
  })
  const applied = result.applied as BoardApplyOutcome[] | undefined
  if (!result.ok)
    return {
      outcomes: failedOutcomes(refs, result.error ?? 'apply failed'),
      transportError: result.error ?? 'apply failed',
    }
  // An `ok` with no payload is a sentinel too old to know the op. Reported as a
  // failure rather than an empty success: nothing was read off disk.
  if (!applied) {
    const error = 'sentinel returned no outcomes -- does it know the `apply` op?'
    return { outcomes: failedOutcomes(refs, error), transportError: error }
  }
  return { outcomes: applied, transportError: null }
}

/** `execute` -- intent, write, outcome. In that order, every time. */
async function handleExecute(ctx: HandlerContext, d: BoardReportRequest): Promise<void> {
  ctx.requirePermission('files', d.project)

  const vetted = vet(d.project, d.execute)
  if (!vetted.ok) {
    reply(ctx, d.requestId, { ok: false, error: vetted.error })
    return
  }
  const { report, refs } = vetted
  const ledger = { project: d.project, reportDate: report.date, traceId: nextTraceId() }

  // 1. INTENT -- before the write, so a press that never returns still leaves a
  //    trace of having been made.
  for (const proposal of refs) recordBoardIntent({ ...ledger, proposal, ts: Date.now() })

  // 2. THE WRITE.
  const { outcomes, transportError } = await performApply(ctx, d.project, report, refs)

  // 3. OUTCOME -- what actually happened, per proposal, never derived from what
  //    was asked for.
  for (const outcome of outcomes) recordBoardOutcome({ ...ledger, outcome, ts: Date.now() })

  const moved = outcomes.filter(o => o.ok).length
  ctx.log.info(
    `[board-report] execute project=${d.project} report=${report.date} trace=${ledger.traceId} ` +
      `${moved}/${outcomes.length} moved${transportError ? ` -- ${transportError}` : ''}`,
  )

  if (transportError) {
    reply(ctx, d.requestId, { ok: false, error: transportError, applied: outcomes })
    return
  }
  reply(ctx, d.requestId, { ok: true, applied: outcomes })
}

/** Exported for its test, which drives it directly rather than through the
 *  router -- the router's job is dispatch, and this file's job is the ordering. */
export const boardReportRequest: MessageHandler = async (ctx, data) => {
  const d = data as BoardReportRequest
  if (!d.project || !d.requestId || !d.op) return
  if (d.op === 'latest') {
    handleLatest(ctx, d)
    return
  }
  if (d.op === 'execute') {
    await handleExecute(ctx, d)
    return
  }
  reply(ctx, d.requestId, { ok: false, error: `unknown board report op: ${String(d.op)}` })
}

export function registerBoardReportHandlers(): void {
  // Same fence as the board relay: the report names cards and executes writes
  // against a project tree, so a share-link guest never sees it.
  registerHandlers({ board_report_request: boardReportRequest }, CONTROL_PANEL_ONLY)
}
