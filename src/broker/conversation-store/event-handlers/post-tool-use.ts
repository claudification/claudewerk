import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * PostToolUse runs three pieces of bookkeeping that all key off the same
 * tool_name discriminant: subagent TaskStop correlation (kills a running
 * subagent that didn't get its own SubagentStop), Bash backgrounding
 * (registers a new bgTask when the tool response carries a background
 * task id), and bg-task completion detection (TaskOutput / TaskStop tool
 * names mark the corresponding bgTask done/killed).
 */
export function handlePostToolUseTracking(session: Conversation, event: HookEventOf<'PostToolUse'>): void {
  const data = event.data
  const toolName = data.tool_name
  const input = data.tool_input
  const responseObj = data.tool_response
  // tool_response can be string OR object - normalize to string for pattern matching
  const responseText =
    typeof responseObj === 'object' && responseObj !== null ? JSON.stringify(responseObj) : String(responseObj ?? '')

  // TaskStop correlation: kills a background agent that didn't fire SubagentStop.
  // task_id IS the agent_id.
  if (toolName === 'TaskStop') {
    const taskId = input.task_id
    if (typeof taskId === 'string') {
      const agent = session.subagents.find(a => a.agentId === taskId && a.status === 'running')
      if (agent) {
        agent.status = 'stopped'
        agent.stoppedAt = event.timestamp
      }
    }
  }

  if (toolName === 'Bash') {
    // Background command detection. Two channels:
    //   1) tool_response is an object with backgroundTaskId
    //   2) string response includes "with ID: xxx" (user pressed Ctrl+B)
    const bgTaskId =
      typeof responseObj === 'object' && responseObj !== null
        ? (responseObj as Record<string, unknown>).backgroundTaskId
        : undefined
    const idMatch = typeof bgTaskId !== 'string' ? responseText.match(/with ID: (\S+)/) : null
    const taskId = typeof bgTaskId === 'string' ? bgTaskId : idMatch?.[1]

    if (taskId) {
      const command = typeof input.command === 'string' ? input.command : ''
      const description = typeof input.description === 'string' ? input.description : ''
      session.bgTasks.push({
        taskId,
        command: command.slice(0, 100),
        description,
        startedAt: event.timestamp,
        status: 'running',
      })
    }
  }

  if (toolName === 'TaskOutput' || toolName === 'TaskStop') {
    const rawTaskId = input.task_id ?? input.taskId
    const taskId = typeof rawTaskId === 'string' ? rawTaskId : ''
    const bgTask = session.bgTasks.find(t => t.taskId === taskId)
    if (bgTask && bgTask.status === 'running') {
      bgTask.completedAt = event.timestamp
      bgTask.status = toolName === 'TaskStop' ? 'killed' : 'completed'
    }
  }
}
