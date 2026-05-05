import type { Conversation, HookEvent, HookEventOf, HookEventType, TranscriptUserEntry } from '../../shared/protocol'
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
 * `event-handlers/`, dispatched through the `eventHandlers` table below.
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

  // Per-event-type dispatch. Stop/StopFailure are handled above as part of
  // the status-transition block (they're conditional on !isSubagentEvent &&
  // !isRecap). Everything else fires unconditionally regardless of subagent
  // origin or recap classification.
  const handler = eventHandlers[event.hookEvent]
  if (handler) handler(ctx, conversationId, session, event)

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

// ─── per-hook-event dispatch table ─────────────────────────────────────────
//
// Each entry below adapts a typed helper (or composition of helpers) to the
// uniform `EventHandler` signature so the orchestrator can dispatch through a
// `Record<HookEventType, EventHandler>`. The `as HookEventOf<...>` cast lives
// at the boundary inside each adapter -- the helpers themselves work with
// the narrow type and never see the union.

type EventHandler = (
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
) => void

function dispatchSessionStart(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  const sessionStartEvent = event as HookEventOf<'SessionStart'>
  handleSessionStart(session, sessionStartEvent)
  handleCompactEvent(ctx, conversationId, session, sessionStartEvent)
}

function dispatchCompact(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleCompactEvent(ctx, conversationId, session, event as HookEventOf<'PreCompact' | 'PostCompact' | 'SessionStart'>)
}

function dispatchCwdChanged(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleCwdChanged(session, event as HookEventOf<'CwdChanged'>)
}

function dispatchPreToolUse(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handlePreToolUse(ctx, conversationId, session, event as HookEventOf<'PreToolUse'>)
}

function dispatchPermissionRequest(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handlePermissionRequest(session, event as HookEventOf<'PermissionRequest'>)
}

function dispatchPermissionDenied(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handlePermissionDenied(ctx, conversationId, session, event as HookEventOf<'PermissionDenied'>)
}

function dispatchElicitation(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleElicitation(session, event as HookEventOf<'Elicitation'>)
}

function dispatchPostToolUse(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  clearPendingAttention(session)
  handlePostToolUseTracking(session, event as HookEventOf<'PostToolUse'>)
}

function dispatchClearPendingAttention(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  _event: HookEvent,
): void {
  clearPendingAttention(session)
}

function dispatchSubagentStart(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleSubagentStart(ctx, conversationId, session, event as HookEventOf<'SubagentStart'>)
}

function dispatchSubagentStop(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleSubagentStop(session, event as HookEventOf<'SubagentStop'>)
}

function dispatchTeammateIdle(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleTeammateIdle(session, event as HookEventOf<'TeammateIdle'>)
}

function dispatchTaskCompleted(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleTaskCompleted(session, event as HookEventOf<'TaskCompleted'>)
}

function dispatchNotification(
  ctx: ConversationStoreContext,
  conversationId: string,
  session: Conversation,
  event: HookEvent,
): void {
  handleNotification(ctx, conversationId, session, event as HookEventOf<'Notification'>)
}

const eventHandlers: Partial<Record<HookEventType, EventHandler>> = {
  SessionStart: dispatchSessionStart,
  CwdChanged: dispatchCwdChanged,
  PreCompact: dispatchCompact,
  PostCompact: dispatchCompact,
  PreToolUse: dispatchPreToolUse,
  PermissionRequest: dispatchPermissionRequest,
  PermissionDenied: dispatchPermissionDenied,
  Elicitation: dispatchElicitation,
  PostToolUse: dispatchPostToolUse,
  PostToolUseFailure: dispatchClearPendingAttention,
  ElicitationResult: dispatchClearPendingAttention,
  SubagentStart: dispatchSubagentStart,
  SubagentStop: dispatchSubagentStop,
  TeammateIdle: dispatchTeammateIdle,
  TaskCompleted: dispatchTaskCompleted,
  Notification: dispatchNotification,
}

// re-export so callers don't need a second import
export type { TranscriptUserEntry }
