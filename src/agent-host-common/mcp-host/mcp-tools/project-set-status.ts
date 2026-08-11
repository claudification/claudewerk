import type { GateOutcome } from '../../../shared/board-gate'
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
  const gate = gateTransition({
    dialogCwd,
    cardPath: locateCard(dialogCwd, taskId)?.abs ?? '',
    fromStatus,
    targetStatus,
    actingConversationId: identity?.conversationId ?? '',
    nowMs: Date.now(),
  })
  ctx.elog(
    `[board-gate] ${taskId} ${fromStatus}->${targetStatus} mode=${gate.mode} decision=${gate.decision} ` +
      `acting=${identity?.conversationId ?? '(none)'} ` +
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
      `The card is where it has always been: ${cardRelPath(taskId)}`,
  )
}
