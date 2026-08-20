import { type GateOutcome, isGatedTarget } from '../../../shared/board-gate'
import { cardRelPath, getProjectTask, locateCard, setProjectTaskStatus } from '../../../shared/project-store'
import { TASK_STATUSES, type TaskStatus } from '../../../shared/task-statuses'
import { debug } from '../debug'
import { gateTransition } from './board-gate-host'
import type { McpToolContext } from './types'

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
 * `off` is a legitimate configuration. Off while the implementer and guard
 * prompts promise "that move machine-captures your evidence" is the defect: a
 * board ran 30 cards through in-review and done with zero `evidence_*` and zero
 * `verdict:` keys, and two overseer generations re-derived merge bases by hand
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
 * project_set_status handler -- change a card's lane, GATED for in-review/done
 * by the deterministic DONE-gate (board-gate.ts). The gate machine-captures git
 * evidence, refuses bad transitions with a precise reason, and enforces the
 * independent-verdict rule (a worker cannot approve itself).
 *
 * The card's FILE does not move: `status` is frontmatter, the path is identity.
 * So there is no lane scan to find it, no destination collision to dedup, and
 * no way for this call to rename a card out from under existing links.
 */
export function handleProjectSetStatus(ctx: McpToolContext, params: Record<string, string>): ToolResult {
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

  // DETERMINISTIC DONE-GATE (§2): earn the transition to in-review/done with
  // machine checks + independent verdict. Evidence is machine-captured here,
  // written into the card at its canonical path.
  const identity = ctx.getIdentity()
  const {
    outcome: gate,
    gitCwd,
    cwdNote,
  } = gateTransition({
    dialogCwd,
    cardId: taskId,
    cardPath: locateCard(dialogCwd, taskId)?.abs ?? '',
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

  if (setProjectTaskStatus(dialogCwd, taskId, targetStatus, Date.now()) === null)
    return text('Failed to set task status', true)
  ctx.callbacks.onProjectChanged?.()
  debug(`[channel] set_task_status: ${taskId} ${fromStatus} -> ${targetStatus}`)
  return text(
    `Moved "${card.title}" from ${formatStatus(fromStatus)} to ${formatStatus(targetStatus)}\n` +
      `The card is where it has always been: ${cardRelPath(taskId)}` +
      gateOffNotice(gate, targetStatus),
  )
}
