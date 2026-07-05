import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GateOutcome } from '../../../shared/board-gate'
import { moveProjectTask } from '../../../shared/project-store'
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

/** Locate a card by scanning status folders. Returns its current status + path. */
function findCard(dialogCwd: string, taskId: string): { fromStatus: TaskStatus; cardPath: string } | null {
  for (const s of TASK_STATUSES) {
    const cardPath = join(dialogCwd, '.rclaude', 'project', s, `${taskId}.md`)
    try {
      if (readdirSync(join(dialogCwd, '.rclaude', 'project', s)).includes(`${taskId}.md`))
        return { fromStatus: s, cardPath }
    } catch {}
  }
  return null
}

function readTitle(cardPath: string, fallback: string): string {
  try {
    return (
      readFileSync(cardPath, 'utf-8')
        .match(/^title:\s*(.+)$/m)?.[1]
        ?.trim() || fallback
    )
  } catch {
    return fallback
  }
}

function refusalText(gate: GateOutcome, fromStatus: TaskStatus, targetStatus: TaskStatus, title: string): string {
  return (
    `DONE-gate refused ${formatStatus(fromStatus)} -> ${formatStatus(targetStatus)} for "${title}" ` +
    `(gate=${gate.mode}):\n${gate.reason}\n\n` +
    'Fix the above and retry. Git facts and the verdict are machine-captured at transition -- ' +
    'you cannot self-report them.'
  )
}

/**
 * project_set_status handler -- move a card between board columns, GATED for
 * in-review/done by the deterministic DONE-gate (board-gate.ts). The gate
 * machine-captures git evidence, refuses bad transitions with a precise reason,
 * and enforces the independent-verdict rule (a worker cannot approve itself).
 */
export function handleProjectSetStatus(ctx: McpToolContext, params: Record<string, string>): ToolResult {
  const taskId = params.id
  const targetStatus = params.status as TaskStatus
  if (!taskId) return text('Error: id is required', true)
  if (!(TASK_STATUSES as readonly string[]).includes(targetStatus))
    return text(`Error: invalid status "${targetStatus}"`, true)

  const dialogCwd = ctx.getDialogCwd()
  const found = findCard(dialogCwd, taskId)
  if (!found) return text(`Task "${taskId}" not found`, true)
  const { fromStatus, cardPath } = found
  if (fromStatus === targetStatus) return text(`"${taskId}" is already ${formatStatus(targetStatus)}`)
  const taskTitle = readTitle(cardPath, taskId)

  // DETERMINISTIC DONE-GATE (§2): earn the transition to in-review/done with
  // machine checks + independent verdict. Evidence is machine-captured here.
  const identity = ctx.getIdentity()
  const gate = gateTransition({
    dialogCwd,
    cardPath,
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
  if (gate.decision === 'refuse') return text(refusalText(gate, fromStatus, targetStatus, taskTitle), true)

  const newSlug = moveProjectTask(dialogCwd, taskId, fromStatus, targetStatus, Date.now())
  if (!newSlug) return text('Failed to move task', true)
  ctx.callbacks.onProjectChanged?.()
  debug(`[channel] set_task_status: ${taskId} ${fromStatus} -> ${targetStatus} (slug: ${newSlug})`)
  const newPath = `.rclaude/project/${targetStatus}/${newSlug}.md`
  const renamed = newSlug !== taskId ? ` (renamed to "${newSlug}")` : ''
  return text(
    `Moved "${taskTitle}" from ${formatStatus(fromStatus)} to ${formatStatus(targetStatus)}${renamed}\nThe task file is now located at ${newPath}`,
  )
}
