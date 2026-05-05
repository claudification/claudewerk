import type { HookEvent, HookEventOf, TranscriptUserEntry } from '../../shared/protocol'
import { recordHookEvent } from '../analytics-store'
import { getProjectSettings } from '../project-settings'
import { MAX_EVENTS, PASSIVE_HOOKS, TRANSCRIPT_KICK_DEBOUNCE_MS, TRANSCRIPT_KICK_EVENT_THRESHOLD } from './constants'
import type { ConversationStoreContext } from './event-context'
import { handleCompactEvent } from './event-handlers/compact'
import { handleCwdChanged } from './event-handlers/cwd'
import { handleNotification } from './event-handlers/notification'
import {
  clearPendingAttention,
  handleElicitation,
  handlePermissionDenied,
  handlePermissionRequest,
} from './event-handlers/permission'
import { handlePostToolUseTracking } from './event-handlers/post-tool-use'
import { handlePreToolUse } from './event-handlers/pre-tool-use'
import { handleSessionStart } from './event-handlers/session-start'
import { handleStop } from './event-handlers/stop'
import { handleSubagentStart, handleSubagentStop } from './event-handlers/subagent'
import { handleTaskCompleted, handleTeammateIdle } from './event-handlers/team'

/**
 * Apply a HookEvent to the matching Conversation: state transitions,
 * lifecycle bookkeeping, derived stats, broadcasts. No-op when the
 * conversationId doesn't resolve.
 *
 * Thin orchestrator: cross-cutting work (push to history, recap detection,
 * subagent correlation, status transitions, broadcast, transcript kick)
 * lives here; per-hook-event behavior is delegated to typed helpers in
 * `event-handlers/`.
 */
export function addEvent(ctx: ConversationStoreContext, conversationId: string, event: HookEvent): void {
  const session = ctx.conversations.get(conversationId)
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
  const hookConversationId = (event.data as { session_id?: unknown }).session_id
  const isSubagentEvent = typeof hookConversationId === 'string' && hookConversationId !== session.id
  if (isSubagentEvent) {
    const subagent = session.subagents.find(a => a.agentId === hookConversationId && a.status === 'running')
    if (subagent) subagent.events.push(event)
  }

  // Detect recap/away_summary events -- these are system-generated, not real user activity.
  // CC fires hook events when processing recaps but they shouldn't flip status to 'active'.
  // Shape lives nested inside `data.input` (CC re-emits the JSONL entry); not in any
  // typed HookEventDataMap entry, so a one-shot narrow cast is the cleanest option.
  const eventInput = (event.data as { input?: { type?: unknown; subtype?: unknown; content?: unknown } }).input
  const isRecap = eventInput?.type === 'system' && eventInput?.subtype === 'away_summary'
  if (isRecap && typeof eventInput?.content === 'string') {
    session.recap = { content: eventInput.content, timestamp: event.timestamp }
    session.recapFresh = true
    ctx.scheduleConversationUpdate(conversationId)
  }

  // Status transitions based on actual Claude hooks (not artificial timers).
  // Skip subagent events -- they shouldn't change the parent's status.
  // Skip recap events -- away_summary is system-generated, not user work.
  if (!isSubagentEvent && !isRecap) {
    if (event.hookEvent === 'Stop' || event.hookEvent === 'StopFailure') {
      handleStop(ctx, conversationId, session, event as HookEventOf<'Stop' | 'StopFailure'>)
    } else if (!PASSIVE_HOOKS.has(event.hookEvent) && session.status !== 'ended') {
      session.status = 'active'
      // Clear error/rate-limit when session resumes working
      if (session.lastError) session.lastError = undefined
      if (session.rateLimit) session.rateLimit = undefined
    }
  }

  // Per-event handlers (each is a no-op when not its event)
  if (event.hookEvent === 'SessionStart') {
    handleSessionStart(session, event as HookEventOf<'SessionStart'>)
  }

  if (event.hookEvent === 'CwdChanged') {
    handleCwdChanged(session, event as HookEventOf<'CwdChanged'>)
  }

  if (event.hookEvent === 'PreCompact' || event.hookEvent === 'PostCompact' || event.hookEvent === 'SessionStart') {
    handleCompactEvent(
      ctx,
      conversationId,
      session,
      event as HookEventOf<'PreCompact' | 'PostCompact' | 'SessionStart'>,
    )
  }

  if (event.hookEvent === 'PreToolUse') {
    handlePreToolUse(ctx, conversationId, session, event as HookEventOf<'PreToolUse'>)
  }

  if (event.hookEvent === 'PermissionRequest') {
    handlePermissionRequest(session, event as HookEventOf<'PermissionRequest'>)
  }

  if (event.hookEvent === 'PermissionDenied') {
    handlePermissionDenied(ctx, conversationId, session, event as HookEventOf<'PermissionDenied'>)
  }

  if (event.hookEvent === 'Elicitation') {
    handleElicitation(session, event as HookEventOf<'Elicitation'>)
  }

  if (
    event.hookEvent === 'PostToolUse' ||
    event.hookEvent === 'PostToolUseFailure' ||
    event.hookEvent === 'ElicitationResult'
  ) {
    clearPendingAttention(session)
  }

  if (event.hookEvent === 'SubagentStart') {
    handleSubagentStart(ctx, conversationId, session, event as HookEventOf<'SubagentStart'>)
  }

  if (event.hookEvent === 'SubagentStop') {
    handleSubagentStop(session, event as HookEventOf<'SubagentStop'>)
  }

  if (event.hookEvent === 'PostToolUse') {
    handlePostToolUseTracking(session, event as HookEventOf<'PostToolUse'>)
  }

  if (event.hookEvent === 'TeammateIdle') {
    handleTeammateIdle(session, event as HookEventOf<'TeammateIdle'>)
  }

  if (event.hookEvent === 'TaskCompleted') {
    handleTaskCompleted(session, event as HookEventOf<'TaskCompleted'>)
  }

  if (event.hookEvent === 'Notification') {
    handleNotification(ctx, conversationId, session, event as HookEventOf<'Notification'>)
  }

  // Broadcast event to dashboard subscribers (channel-filtered for v2)
  ctx.broadcastToChannel('conversation:events', conversationId, {
    type: 'event',
    conversationId,
    event,
  })

  // Transcript kick: if events are flowing but no transcript entries, nudge the agent host
  if (
    session.events.length >= TRANSCRIPT_KICK_EVENT_THRESHOLD &&
    !ctx.transcriptCache.has(conversationId) &&
    session.status !== 'ended'
  ) {
    const now = Date.now()
    const lastKick = ctx.lastTranscriptKick.get(conversationId) || 0
    if (now - lastKick > TRANSCRIPT_KICK_DEBOUNCE_MS) {
      ctx.lastTranscriptKick.set(conversationId, now)
      const wrappers = ctx.conversationSockets.get(conversationId)
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
  ctx.scheduleConversationUpdate(conversationId)
}

// re-export so callers don't need a second import
export type { TranscriptUserEntry }
