import { type GateOutcome, isGatedTarget } from '../../../shared/board-gate'
import { type VerdictDecision, verdictDecisionFor } from '../../../shared/card-verdict'
import { cardRelPath, getProjectTask, locateCard, setProjectTaskStatus } from '../../../shared/project-store'
import { TASK_STATUSES, type TaskStatus } from '../../../shared/task-statuses'
import { debug } from '../debug'
import { gateTransition } from './board-gate-host'
import { writeVerdictToCard } from './card-verdict-write'
import type { McpToolContext } from './types'
import { rememberVerdict } from './verdict-harvest'

function formatStatus(s: string): string {
  return s
    .split('-')
    .map(w => w[0].toUpperCase() + w.slice(1))
    .join('-')
}

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean }
const text = (t: string, isError = false): ToolResult => ({
  content: [{ type: 'text', text: t }],
  isError: isError || undefined,
})

function refusalText(gate: GateOutcome, fromStatus: TaskStatus, targetStatus: TaskStatus, title: string): string {
  return (
    `DONE-gate refused ${formatStatus(fromStatus)} -> ${formatStatus(targetStatus)} for "${title}" ` +
    `(gate=${gate.mode}):\n${gate.reason}\n\n` +
    'Fix the above and retry. Git facts and the verdict are machine-captured at transition -- ' +
    'you cannot self-report them.'
  )
}

/**
 * A move into a GATED lane that was not in fact gated must say so.
 *
 * `off` is a legitimate configuration. Off while the werk-worker and guard
 * prompts promise "that move machine-captures your evidence" is the defect: a
 * board ran 30 cards through in-review and done with zero `evidence_*` and zero
 * `verdict:` keys, and two werk-master generations re-derived merge bases by hand
 * before anyone noticed the gate had never executed. So the success message now
 * tells the caller, at the moment of the move, that nothing was captured.
 */
function gateOffNotice(gate: GateOutcome, targetStatus: TaskStatus): string {
  if (gate.decision !== 'skip' || gate.mode !== 'off' || !isGatedTarget(targetStatus)) return ''
  return (
    '\n\nGATE OFF -- nothing was machine-captured for this move: no evidence_* keys, no verdict. ' +
    "Anything this card says about its branch, diff or tests is the worker's own word, " +
    'and no check stopped the worker approving itself. ' +
    'Enable it with `.rclaude/project/gate.conf` (`tier2` or `full`) or a per-card `gate:` key.'
  )
}

/**
 * NAME WHAT RAN. "tests passed" on a card used to mean "the string in `test_cmd`
 * exited 0", which on three cards here meant the web suite never ran at all. The
 * gate now derives suites from the diff, so the move reports the commands it
 * actually executed rather than letting the reader assume all of them.
 */
function gateRanNotice(gate: GateOutcome): string {
  const suites = gate.evidence.evidence_suites
  if (gate.decision !== 'allow' || !Array.isArray(suites) || suites.length === 0) return ''
  return `\n\nGate ran:\n${suites.map(s => `  - ${s}`).join('\n')}`
}

/**
 * WHAT A SEAT IS TOLD WHEN IT TRIES TO CLOSE A REVIEW WITHOUT SAYING ANYTHING.
 *
 * Names the parameter and the shape of the answer, because a refusal that only
 * says "no" gets retried verbatim. This is the loud half of "a verdict that is
 * not on the card was not delivered": the review does not close at all until the
 * judgement exists somewhere a reader will find it.
 */
function missingVerdictText(decision: VerdictDecision, cardId: string, targetStatus: TaskStatus): string {
  const what =
    decision === 'APPROVED'
      ? 'what you ran, what you saw, and why that is enough'
      : 'exactly what failed and the command output that proves it'
  return (
    `REFUSED: leaving in-review is a VERDICT, and this call carries none.\n` +
    `Retry with the verdict as a parameter:\n` +
    `  project_set_status(id="${cardId}", status="${targetStatus}", verdict="<${what}>")\n\n` +
    'It is written into the card body under `## Verdict`, attributed to your conversation id and stamped ' +
    'with the time -- both machine-supplied, neither yours to write. A verdict that lives only in this ' +
    'transcript is one the next reader of this board cannot find, which is indistinguishable from a card ' +
    'nobody reviewed.'
  )
}

/**
 * The verdict write FAILED. The lane does not move.
 *
 * This is the case the card exists for: a review that reports success while its
 * judgement went nowhere. Better a verifier that has to retry than a `done` card
 * whose approval nobody can produce.
 */
function verdictWriteFailedText(cardId: string, error: string): string {
  return (
    `REFUSED: the lane did NOT move -- your verdict could not be written to \`${cardId}\`.\n${error}\n\n` +
    'The move is deliberately tied to the write: a card that reads settled with no verdict on it is the ' +
    'exact failure this refusal exists to prevent. Fix the cause and retry the same call.'
  )
}

/**
 * project_set_status handler -- change a card's lane, GATED for in-review/done
 * by the deterministic DONE-gate (board-gate.ts). The gate machine-captures git
 * evidence, refuses bad transitions with a precise reason, and enforces the
 * independent-verdict rule (a worker cannot approve itself).
 *
 * IT IS ALSO THE VERDICT VERB. A move OUT of `in-review` closes a review, so it
 * carries `verdict` (plus optional `caveats`/`notes`) and writes it into the card
 * body before the lane moves. No verdict, or a verdict that cannot be written,
 * and the move is REFUSED -- see card-verdict.ts for the failure that bought this.
 *
 * The card's FILE does not move: `status` is frontmatter, the path is identity.
 * So there is no lane scan to find it, no destination collision to dedup, and
 * no way for this call to rename a card out from under existing links.
 */
export async function handleProjectSetStatus(ctx: McpToolContext, params: Record<string, string>): Promise<ToolResult> {
  const taskId = params.id
  const targetStatus = params.status as TaskStatus
  if (!taskId) return text('Error: id is required', true)
  if (!(TASK_STATUSES as readonly string[]).includes(targetStatus))
    return text(`Error: invalid status "${targetStatus}"`, true)

  const dialogCwd = ctx.getDialogCwd()
  const card = getProjectTask(dialogCwd, taskId)
  if (!card) return text(`Task "${taskId}" not found`, true)
  const fromStatus = card.status
  if (fromStatus === targetStatus) return text(`"${taskId}" is already ${formatStatus(targetStatus)}`)

  // A VERDICT THAT IS NOT ON THE CARD WAS NOT DELIVERED (card-verdict.ts).
  // Checked BEFORE the gate on purpose: the gate may run this card's whole test
  // suite for minutes, and refusing afterwards for a missing parameter would
  // burn all of it on a call that was never going to be allowed.
  const decision = verdictDecisionFor(fromStatus, targetStatus)
  const summary = (params.verdict ?? '').trim()
  if (decision && !summary) return text(missingVerdictText(decision, taskId, targetStatus), true)

  // DETERMINISTIC DONE-GATE (§2): earn the transition to in-review/done with
  // machine checks + independent verdict. Evidence is machine-captured here,
  // written into the card at its canonical path.
  const identity = ctx.getIdentity()
  const cardAbs = locateCard(dialogCwd, taskId)?.abs ?? ''
  // Awaited, not blocking: the gate may run the card's `test_cmd` for minutes and
  // the host has to keep serving this conversation's other tool calls meanwhile.
  const {
    outcome: gate,
    gitCwd,
    cwdNote,
  } = await gateTransition({
    dialogCwd,
    cardId: taskId,
    cardPath: cardAbs,
    fromStatus,
    targetStatus,
    actingConversationId: identity?.conversationId ?? '',
    nowMs: Date.now(),
  })
  ctx.elog(
    `[board-gate] ${taskId} ${fromStatus}->${targetStatus} mode=${gate.mode} decision=${gate.decision} ` +
      `acting=${identity?.conversationId ?? '(none)'} cwd=${gitCwd} (${cwdNote}) ` +
      `checks=[${gate.checks.map(c => `${c.name}:${c.ok ? 'ok' : 'FAIL'}`).join(',')}]` +
      (gate.reason ? ` reason="${gate.reason}"` : ''),
  )
  if (gate.decision === 'refuse') return text(refusalText(gate, fromStatus, targetStatus, card.title), true)

  // THE VERDICT LANDS BEFORE THE LANE MOVES, and a failure to write it refuses
  // the move outright. Written AFTER the gate because the gate has just stamped
  // its evidence keys into this same file -- this write re-reads and carries
  // them forward rather than racing them.
  let verdictNote = ''
  if (decision) {
    const verdict = {
      decision,
      by: identity?.conversationId || 'unknown-conversation',
      at: new Date().toISOString(),
      summary,
      ...(params.caveats?.trim() ? { caveats: params.caveats.trim() } : {}),
      ...(params.notes?.trim() ? { notes: params.notes.trim() } : {}),
    }
    const written = writeVerdictToCard(cardAbs, verdict)
    ctx.elog(`[verdict] ${taskId} ${decision} by ${verdict.by} -> ${written.ok ? 'written' : written.error}`)
    if (!written.ok) return text(verdictWriteFailedText(taskId, written.error), true)
    rememberVerdict(verdict.by, { cardId: taskId, cardPath: cardAbs, input: verdict })
    verdictNote =
      `\n\nVerdict written to the card body: **${decision}** by \`${verdict.by}\`. ` +
      'Any `caveats`/`notes` you report with `set_status` from here on are folded into it automatically.'
  }

  if (setProjectTaskStatus(dialogCwd, taskId, targetStatus, Date.now()) === null)
    return text('Failed to set task status', true)
  ctx.callbacks.onProjectChanged?.()
  debug(`[channel] set_task_status: ${taskId} ${fromStatus} -> ${targetStatus}`)
  return text(
    `Moved "${card.title}" from ${formatStatus(fromStatus)} to ${formatStatus(targetStatus)}\n` +
      `The card is where it has always been: ${cardRelPath(taskId)}` +
      gateRanNotice(gate) +
      verdictNote +
      gateOffNotice(gate, targetStatus),
  )
}
