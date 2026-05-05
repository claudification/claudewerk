import type { Conversation, HookEventOf } from '../../../shared/protocol'

/**
 * TeammateIdle: register the team membership on first sighting, then
 * upsert the teammate row to idle. Idle teammates have cleared their
 * current task assignment.
 */
export function handleTeammateIdle(conv: Conversation, event: HookEventOf<'TeammateIdle'>): void {
  const data = event.data
  const teamName = data.team_name ?? ''
  const agentId = data.agent_id ?? ''
  const agentName = data.agent_name ?? agentId.slice(0, 8)

  if (teamName && !conv.team) {
    conv.team = { teamName, role: 'lead' }
  }

  if (!agentId) return

  let teammate = conv.teammates.find(t => t.agentId === agentId)
  if (!teammate) {
    teammate = {
      agentId,
      name: agentName,
      teamName,
      status: 'idle',
      startedAt: event.timestamp,
      completedTaskCount: 0,
    }
    conv.teammates.push(teammate)
  }
  teammate.status = 'idle'
  teammate.currentTaskId = undefined
  teammate.currentTaskSubject = undefined
}

/**
 * TaskCompleted: bump the matching teammate's completedTaskCount and
 * clear their current-task assignment. Lookup is by name (owner) since
 * task events identify the agent by name, not agent_id.
 */
export function handleTaskCompleted(conv: Conversation, event: HookEventOf<'TaskCompleted'>): void {
  const data = event.data
  const owner = data.owner ?? ''
  const teamName = data.team_name ?? ''

  if (teamName && !conv.team) {
    conv.team = { teamName, role: 'lead' }
  }

  const teammate = conv.teammates.find(t => t.name === owner)
  if (!teammate) return

  teammate.completedTaskCount++
  teammate.currentTaskId = undefined
  teammate.currentTaskSubject = undefined
  teammate.status = 'idle'
}
