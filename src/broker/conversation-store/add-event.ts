import { extractProjectLabel } from '../../shared/project-uri'
import type { HookEvent, TranscriptUserEntry } from '../../shared/protocol'
import { recordHookEvent } from '../analytics-store'
import { getModelInfo } from '../model-pricing'
import { getProjectSettings } from '../project-settings'
import { MAX_EVENTS, PASSIVE_HOOKS, TRANSCRIPT_KICK_DEBOUNCE_MS, TRANSCRIPT_KICK_EVENT_THRESHOLD } from './constants'
import type { ConversationStoreContext } from './event-context'

/**
 * Apply a HookEvent to the matching Conversation: state transitions,
 * lifecycle bookkeeping, derived stats, broadcasts. No-op when the
 * conversationId doesn't resolve.
 *
 * Pulled out of createConversationStore wholesale (was 470+ lines inside
 * the factory). Behavior unchanged -- ConversationStoreContext supplies
 * everything that used to be a closure capture.
 */
export function addEvent(ctx: ConversationStoreContext, conversationId: string, event: HookEvent): void {
  const {
    conversations,
    conversationSockets,
    transcriptCache,
    pendingAgentDescriptions,
    lastTranscriptKick,
    store,
    scheduleConversationUpdate,
    broadcastToChannel,
    broadcastConversationScoped,
    addTranscriptEntries,
  } = ctx

  const session = conversations.get(conversationId)
  if (!session) return

  session.events.push(event)
  if (session.events.length > MAX_EVENTS) {
    session.events.splice(0, session.events.length - MAX_EVENTS)
  }
  session.lastActivity = Date.now()

  // Feed analytics store (non-blocking, fire-and-forget)
  recordHookEvent(conversationId, event.hookEvent, (event.data || {}) as Record<string, unknown>, {
    projectUri: session.project,
    model: session.model || '',
    account: (session.claudeAuth?.email as string) || '',
    projectLabel: getProjectSettings(session.project)?.label,
  })

  // Correlate hook events to subagents: if the hook's session_id differs
  // from the parent session ID, it came from a subagent context.
  // MUST happen BEFORE status transitions so subagent activity doesn't
  // flip the parent from idle -> active (spinner stays on after Stop).
  const hookConversationId = (event.data as Record<string, unknown>)?.session_id
  const isSubagentEvent = typeof hookConversationId === 'string' && hookConversationId !== session.id
  if (isSubagentEvent) {
    const subagent = session.subagents.find(a => a.agentId === hookConversationId && a.status === 'running')
    if (subagent) {
      subagent.events.push(event)
    }
  }

  // Detect recap/away_summary events -- these are system-generated, not real user activity.
  // CC fires hook events when processing recaps but they shouldn't flip status to 'active'.
  const eventData = event.data as Record<string, unknown> | undefined
  const eventInput = eventData?.input as Record<string, unknown> | undefined
  const isRecap = eventInput?.type === 'system' && eventInput?.subtype === 'away_summary'
  if (isRecap && typeof eventInput?.content === 'string') {
    session.recap = { content: eventInput.content, timestamp: event.timestamp }
    session.recapFresh = true
    scheduleConversationUpdate(conversationId)
  }

  // Status transitions based on actual Claude hooks (not artificial timers).
  // Skip subagent events -- they shouldn't change the parent's status.
  // Skip recap events -- away_summary is system-generated, not user work.
  if (!isSubagentEvent && !isRecap) {
    if (event.hookEvent === 'Stop' || event.hookEvent === 'StopFailure') {
      session.status = 'idle'
      session.lastTurnEndedAt = event.timestamp
      // Capture error details from StopFailure
      if (event.hookEvent === 'StopFailure' && event.data) {
        const d = event.data as Record<string, unknown>
        session.lastError = {
          stopReason: String(d.stop_reason || d.stopReason || ''),
          errorType: String(d.error_type || d.errorType || ''),
          errorMessage: String(d.error_message || d.errorMessage || d.error || ''),
          timestamp: event.timestamp,
        }
      }

      // Record estimated cost for PTY sessions (headless uses exact turn_cost)
      if (event.hookEvent === 'Stop' && !session.capabilities?.includes('headless')) {
        const s = session.stats
        if (s.totalInputTokens > 0 || s.totalOutputTokens > 0) {
          // Estimate cumulative cost using LiteLLM pricing + split cache write tiers
          const info = session.model ? getModelInfo(session.model) : undefined
          let totalEstCost: number
          if (info) {
            const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
            const cacheReadCost = info.cacheReadCostPerToken ?? info.inputCostPerToken * 0.125
            const cacheWrite5mCost = info.cacheWriteCostPerToken ?? info.inputCostPerToken * 1.25
            const cacheWrite1hCost = info.inputCostPerToken * 2.0
            totalEstCost =
              uncached * info.inputCostPerToken +
              s.totalOutputTokens * info.outputCostPerToken +
              s.totalCacheRead * cacheReadCost +
              s.totalCacheWrite5m * cacheWrite5mCost +
              s.totalCacheWrite1h * cacheWrite1hCost
          } else {
            const uncached = Math.max(0, s.totalInputTokens - s.totalCacheCreation - s.totalCacheRead)
            totalEstCost =
              (uncached * 15 +
                s.totalOutputTokens * 75 +
                s.totalCacheRead * 1.875 +
                s.totalCacheWrite5m * 18.75 +
                s.totalCacheWrite1h * 30) /
              1_000_000
          }
          // Delta computation handled inside store.costs.recordTurnFromCumulatives
          store?.costs.recordTurnFromCumulatives({
            timestamp: event.timestamp,
            conversationId,
            projectUri: session.project,
            account: session.claudeAuth?.email || '',
            orgId: session.claudeAuth?.orgId || '',
            model: session.model || '',
            totalInputTokens: s.totalInputTokens,
            totalOutputTokens: s.totalOutputTokens,
            totalCacheRead: s.totalCacheRead,
            totalCacheWrite: s.totalCacheCreation,
            totalCostUsd: totalEstCost,
            exactCost: false,
          })
        }
      }
    } else if (!PASSIVE_HOOKS.has(event.hookEvent) && session.status !== 'ended') {
      session.status = 'active'
      // Clear error/rate-limit when session resumes working
      if (session.lastError) session.lastError = undefined
      if (session.rateLimit) session.rateLimit = undefined
    }
  }

  // Extract transcript_path and model from SessionStart events
  if (event.hookEvent === 'SessionStart' && event.data) {
    const data = event.data as Record<string, unknown>
    if (data.transcript_path && typeof data.transcript_path === 'string') {
      session.transcriptPath = data.transcript_path
    }
    if (data.model && typeof data.model === 'string') {
      session.model = data.model
    }
    // Clear stale error from previous run (belt and suspenders with resumeConversation)
    session.lastError = undefined
  }

  // Track current working directory (NOT the conversation's project root).
  // session.project stays as the launch project URI (project identity).
  // session.currentPath tracks where Claude is working right now.
  if (event.hookEvent === 'CwdChanged' && event.data) {
    const data = event.data as Record<string, unknown>
    if (data.cwd && typeof data.cwd === 'string') {
      session.currentPath = data.cwd
    }
  }

  // Track compacting state + inject synthetic transcript markers.
  // PreCompact -> compacting=true, PostCompact -> compacting=false + compacted marker.
  // PostCompact was added in Claude Code 2.1.76 as the definitive completion signal.
  // Fallback: SessionStart after PreCompact also clears compacting (older CC versions).
  if (event.hookEvent === 'PreCompact') {
    session.compacting = true
    const marker = { type: 'compacting', timestamp: new Date().toISOString() }
    addTranscriptEntries(conversationId, [marker], false)
    broadcastToChannel('conversation:transcript', conversationId, {
      type: 'transcript_entries',
      conversationId,
      entries: [marker],
      isInitial: false,
    })
  } else if (event.hookEvent === 'PostCompact' && session.compacting) {
    session.compacting = false
    session.compactedAt = Date.now()
    const marker = { type: 'compacted', timestamp: new Date().toISOString() }
    addTranscriptEntries(conversationId, [marker], false)
    broadcastToChannel('conversation:transcript', conversationId, {
      type: 'transcript_entries',
      conversationId,
      entries: [marker],
      isInitial: false,
    })
  } else if (session.compacting && event.hookEvent === 'SessionStart') {
    // Fallback for CC < 2.1.76 (no PostCompact): SessionStart after PreCompact = done
    session.compacting = false
    session.compactedAt = Date.now()
    const marker = { type: 'compacted', timestamp: new Date().toISOString() }
    addTranscriptEntries(conversationId, [marker], false)
    broadcastToChannel('conversation:transcript', conversationId, {
      type: 'transcript_entries',
      conversationId,
      entries: [marker],
      isInitial: false,
    })
  }

  // Capture agent description from PreToolUse(Agent) tool calls
  if (event.hookEvent === 'PreToolUse' && event.data) {
    const data = event.data as Record<string, unknown>
    if (data.tool_name === 'Agent' && data.tool_input) {
      const input = data.tool_input as Record<string, unknown>
      if (input.description && typeof input.description === 'string') {
        const queue = pendingAgentDescriptions.get(conversationId) || []
        queue.push(input.description)
        pendingAgentDescriptions.set(conversationId, queue)
      }
    }
    // Track AskUserQuestion PreToolUse - might block waiting for user
    if (data.tool_name === 'AskUserQuestion') {
      session.pendingAttention = {
        type: 'ask',
        toolName: 'AskUserQuestion',
        question: (data.tool_input as Record<string, unknown>)?.question as string | undefined,
        timestamp: event.timestamp,
      }
    }
  }

  // PermissionRequest - Claude is blocked waiting for permission approval
  if (event.hookEvent === 'PermissionRequest' && event.data) {
    const data = event.data as Record<string, unknown>
    session.pendingAttention = {
      type: 'permission',
      toolName: data.tool_name as string | undefined,
      filePath: (data.tool_input as Record<string, unknown>)?.file_path as string | undefined,
      timestamp: event.timestamp,
    }
  }

  // PermissionDenied - Claude was denied permission (tool blocked by user rules)
  if (event.hookEvent === 'PermissionDenied' && event.data) {
    const data = event.data as Record<string, unknown>
    // Clear any pending permission state since it's now resolved (denied)
    if (session.pendingAttention?.type === 'permission') {
      session.pendingAttention = undefined
    }
    if (session.pendingPermission) {
      session.pendingPermission = undefined
    }
    const toolName = data.tool_name as string | undefined
    const projectName = getProjectSettings(session.project)?.label || extractProjectLabel(session.project)
    broadcastConversationScoped(
      {
        type: 'toast',
        conversationId,
        title: projectName,
        message: `Permission denied: ${toolName || 'unknown tool'}`,
      },
      session.project,
    )
  }

  // Elicitation - Claude is asking a structured question
  if (event.hookEvent === 'Elicitation' && event.data) {
    const data = event.data as Record<string, unknown>
    session.pendingAttention = {
      type: 'elicitation',
      question: data.message as string | undefined,
      timestamp: event.timestamp,
    }
  }

  // Clear pendingAttention + stored request payloads on resolution events
  if (
    event.hookEvent === 'PostToolUse' ||
    event.hookEvent === 'PostToolUseFailure' ||
    event.hookEvent === 'ElicitationResult'
  ) {
    if (session.pendingAttention) {
      session.pendingAttention = undefined
    }
    if (session.pendingPermission) {
      session.pendingPermission = undefined
    }
    if (session.pendingAskQuestion) {
      session.pendingAskQuestion = undefined
    }
  }

  // Track sub-agent lifecycle
  if (event.hookEvent === 'SubagentStart' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    if (agentId && !session.subagents.some(a => a.agentId === agentId)) {
      const queue = pendingAgentDescriptions.get(conversationId)
      const description = queue?.shift()
      session.subagents.push({
        agentId,
        agentType: String(data.agent_type || 'unknown'),
        description,
        startedAt: event.timestamp,
        status: 'running',
        events: [],
      })
    }
  }

  if (event.hookEvent === 'SubagentStop' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    const agent = session.subagents.find(a => a.agentId === agentId)
    if (agent) {
      agent.stoppedAt = event.timestamp
      agent.status = 'stopped'
      if (data.agent_transcript_path && typeof data.agent_transcript_path === 'string') {
        agent.transcriptPath = data.agent_transcript_path
      }
    }
  }

  // TaskStop kills a background agent without firing SubagentStop.
  // Correlate by task_id (which is the agent_id) to mark it stopped.
  if (event.hookEvent === 'PostToolUse' && event.data) {
    const data = event.data as Record<string, unknown>
    if (data.tool_name === 'TaskStop' && data.tool_input) {
      const taskId = (data.tool_input as Record<string, unknown>).task_id as string | undefined
      if (taskId) {
        const agent = session.subagents.find(a => a.agentId === taskId && a.status === 'running')
        if (agent) {
          agent.status = 'stopped'
          agent.stoppedAt = event.timestamp
        }
      }
    }
  }

  // Track background Bash commands
  if (event.hookEvent === 'PostToolUse' && event.data) {
    const data = event.data as Record<string, unknown>
    const toolName = data.tool_name as string
    const input = (data.tool_input || {}) as Record<string, unknown>
    const responseObj = data.tool_response
    // tool_response can be a string OR an object - normalize to string for pattern matching
    const response =
      typeof responseObj === 'object' && responseObj !== null ? JSON.stringify(responseObj) : String(responseObj || '')

    if (toolName === 'Bash') {
      // Detect background commands - tool_response is an object with backgroundTaskId
      const bgTaskId =
        typeof responseObj === 'object' && responseObj !== null
          ? ((responseObj as Record<string, unknown>).backgroundTaskId as string | undefined)
          : undefined
      // Fallback: match "with ID: xxx" in string response (user Ctrl+B backgrounded)
      const idMatch = !bgTaskId ? response.match(/with ID: (\S+)/) : null
      const taskId = bgTaskId || idMatch?.[1]

      if (taskId) {
        session.bgTasks.push({
          taskId,
          command: String(input.command || '').slice(0, 100),
          description: String(input.description || ''),
          startedAt: event.timestamp,
          status: 'running',
        })
      }
    }

    // Detect TaskOutput/TaskStop to mark bg tasks as completed
    if (toolName === 'TaskOutput' || toolName === 'TaskStop') {
      const taskId = String(input.task_id || input.taskId || '')
      const bgTask = session.bgTasks.find(t => t.taskId === taskId)
      if (bgTask && bgTask.status === 'running') {
        bgTask.completedAt = event.timestamp
        bgTask.status = toolName === 'TaskStop' ? 'killed' : 'completed'
      }
    }
  }

  // Detect team membership from TeammateIdle events
  if (event.hookEvent === 'TeammateIdle' && event.data) {
    const data = event.data as Record<string, unknown>
    const teamName = String(data.team_name || '')
    const agentId = String(data.agent_id || '')
    const agentName = String(data.agent_name || agentId.slice(0, 8))

    if (teamName && !session.team) {
      session.team = { teamName, role: 'lead' }
    }

    if (agentId) {
      let teammate = session.teammates.find(t => t.agentId === agentId)
      if (!teammate) {
        teammate = {
          agentId,
          name: agentName,
          teamName,
          status: 'idle',
          startedAt: event.timestamp,
          completedTaskCount: 0,
        }
        session.teammates.push(teammate)
      }
      teammate.status = 'idle'
      teammate.currentTaskId = undefined
      teammate.currentTaskSubject = undefined
    }
  }

  // Track teammate work from SubagentStart (teammates are agents)
  if (event.hookEvent === 'SubagentStart' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    const teammate = session.teammates.find(t => t.agentId === agentId)
    if (teammate) {
      teammate.status = 'working'
    }
  }

  // Track teammate stop
  if (event.hookEvent === 'SubagentStop' && event.data) {
    const data = event.data as Record<string, unknown>
    const agentId = String(data.agent_id || '')
    const teammate = session.teammates.find(t => t.agentId === agentId)
    if (teammate) {
      teammate.status = 'stopped'
      teammate.stoppedAt = event.timestamp
    }
  }

  // Track task completion by teammates
  if (event.hookEvent === 'TaskCompleted' && event.data) {
    const data = event.data as Record<string, unknown>
    const owner = String(data.owner || '')
    const teamName = String(data.team_name || '')

    if (teamName && !session.team) {
      session.team = { teamName, role: 'lead' }
    }

    // Find teammate by name match (owner is the agent name)
    const teammate = session.teammates.find(t => t.name === owner)
    if (teammate) {
      teammate.completedTaskCount++
      teammate.currentTaskId = undefined
      teammate.currentTaskSubject = undefined
      // Back to idle after completing
      teammate.status = 'idle'
    }
  }

  // Notification hook -> toast + unread badge
  if (event.hookEvent === 'Notification') {
    session.hasNotification = true
    const data = event.data as Record<string, unknown>
    const message = typeof data.message === 'string' ? data.message : 'Needs attention'
    const projectName = getProjectSettings(session.project)?.label || extractProjectLabel(session.project)
    broadcastConversationScoped(
      {
        type: 'toast',
        conversationId,
        title: projectName,
        message,
      },
      session.project,
    )
  }

  // Broadcast event to dashboard subscribers (channel-filtered for v2)
  broadcastToChannel('conversation:events', conversationId, {
    type: 'event',
    conversationId,
    event,
  })

  // Transcript kick: if events are flowing but no transcript entries, nudge the agent host
  if (
    session.events.length >= TRANSCRIPT_KICK_EVENT_THRESHOLD &&
    !transcriptCache.has(conversationId) &&
    session.status !== 'ended'
  ) {
    const now = Date.now()
    const lastKick = lastTranscriptKick.get(conversationId) || 0
    if (now - lastKick > TRANSCRIPT_KICK_DEBOUNCE_MS) {
      lastTranscriptKick.set(conversationId, now)
      // Find the agent host socket for this conversation and send kick
      const wrappers = conversationSockets.get(conversationId)
      if (wrappers) {
        for (const ws of wrappers.values()) {
          try {
            ws.send(JSON.stringify({ type: 'transcript_kick', conversationId }))
            console.log(`[session-store] Sent transcript_kick to wrapper for ${conversationId.slice(0, 8)}`)
          } catch {
            // Wrapper socket may be dead
          }
        }
      }
    }
  }

  // Coalesce session update (for lastActivity, eventCount changes)
  scheduleConversationUpdate(conversationId)
}

// re-export so callers don't need a second import
export type { TranscriptUserEntry }
