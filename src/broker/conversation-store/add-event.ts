import type { Conversation, HookEvent, HookEventOf, HookEventType, TranscriptUserEntry } from '../../shared/protocol'
import { parseRecapContent } from '../../shared/recap'
import { recordHookEvent } from '../analytics-store'
import { getProjectSettings } from '../project-settings'
import { MAX_EVENTS, PASSIVE_HOOKS, TRANSCRIPT_KICK_EVENT_THRESHOLD } from './constants'
import type { ConversationStoreContext } from './event-context'
import { handleCompactEvent } from './event-handlers/compact'
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
/**
 * Resolve the subagent that a hook event originated from, or undefined for a
 * parent-originated event. The agent host stamps subagent-originated hooks with
 * `subagentId` (the SubagentStart agent_id) -- in the current CC version every
 * subagent hook otherwise carries the PARENT session id and no subagent marker,
 * so this explicit field is the only reliable signal. Legacy fallback: a
 * CC-populated `data.conversation_id` that differs from the parent, kept for
 * older/future CC builds that might set it.
 */
function detectSubagentOrigin(conv: Conversation, event: HookEvent): string | undefined {
  if (typeof event.subagentId === 'string') return event.subagentId
  const legacyHookConvId = (event.data as { conversation_id?: unknown }).conversation_id
  if (typeof legacyHookConvId === 'string' && legacyHookConvId !== conv.id) return legacyHookConvId
  return undefined
}

export function addEvent(ctx: ConversationStoreContext, conversationId: string, event: HookEvent): void {
  const conv = ctx.conversations.get(conversationId)
  if (!conv) return

  conv.events.push(event)
  if (conv.events.length > MAX_EVENTS) {
    conv.events.splice(0, conv.events.length - MAX_EVENTS)
  }
  conv.lastActivity = Date.now()

  // Feed analytics store (non-blocking, fire-and-forget)
  recordHookEvent(conversationId, event.hookEvent, (event.data || {}) as Record<string, unknown>, {
    projectUri: conv.project,
    model: conv.model || '',
    account: (conv.claudeAuth?.email as string) || '',
    projectLabel: getProjectSettings(conv.project)?.label,
  })

  // Correlate hook events to subagents (see detectSubagentOrigin). When
  // subagent-originated we push the event to the subagent's bucket and suppress
  // EVERY parent-level side effect below: no idle->active status flip (spinner
  // staying on after Stop was a symptom), no model clobber via SessionStart, no
  // compaction-state flip via Pre/PostCompact, no parent tool tracking.
  const subagentId = detectSubagentOrigin(conv, event)
  const isSubagentEvent = subagentId !== undefined
  if (isSubagentEvent) {
    const subagent = conv.subagents.find(a => a.agentId === subagentId && a.status === 'running')
    if (subagent) subagent.events.push(event)
  }

  // Detect recap/away_summary events -- these are system-generated, not real user activity.
  // CC fires hook events when processing recaps but they shouldn't flip status to 'active'.
  // Shape lives nested inside `data.input` (CC re-emits the JSONL entry); not in any
  // typed HookEventDataMap entry, so a one-shot narrow cast is the cleanest option.
  const eventInput = (event.data as { input?: { type?: unknown; subtype?: unknown; content?: unknown } }).input
  const isRecap = eventInput?.type === 'system' && eventInput?.subtype === 'away_summary'
  if (isRecap && typeof eventInput?.content === 'string') {
    const parsed = parseRecapContent(eventInput.content)
    conv.recap = { content: parsed.recap, title: parsed.title || undefined, timestamp: event.timestamp }
    conv.recapFresh = true
    ctx.scheduleConversationUpdate(conversationId)
  }

  // Status transitions based on actual Claude hooks (not artificial timers).
  // Skip subagent events -- they shouldn't change the parent's status.
  // Skip recap events -- away_summary is system-generated, not user work.
  if (!isSubagentEvent && !isRecap) {
    if (event.hookEvent === 'Stop' || event.hookEvent === 'StopFailure') {
      handleStop(ctx, conversationId, conv, event as HookEventOf<'Stop' | 'StopFailure'>)
    } else if (!PASSIVE_HOOKS.has(event.hookEvent) && conv.status !== 'ended') {
      conv.status = 'active'
      // Clear error/rate-limit when conversation resumes working
      if (conv.lastError) conv.lastError = undefined
      if (conv.rateLimit) conv.rateLimit = undefined
    }
  }

  // Per-event-type dispatch. Stop/StopFailure are handled above as part of the
  // status-transition block (conditional on !isSubagentEvent && !isRecap).
  // Subagent-originated hooks are CONTAINED: skipping the dispatch keeps every
  // parent-level side effect off the parent (model clobber via SessionStart,
  // compaction-state flip via Pre/PostCompact, parent tool tracking) -- their
  // only effects are the subagent.events push above + the broadcast below. The
  // roster/lifecycle hooks the broker needs (SubagentStart/Stop, TeammateIdle,
  // TaskCompleted) are never tagged subagent-originated by the agent host, so
  // they still reach their handlers here.
  if (!isSubagentEvent) {
    const handler = eventHandlers[event.hookEvent]
    if (handler) handler(ctx, conversationId, conv, event)
  }

  // Broadcast event to dashboard subscribers (channel-filtered for v2)
  ctx.broadcastToChannel('conversation:events', conversationId, {
    type: 'event',
    conversationId,
    event,
  })

  // Transcript kick: if events are flowing but no transcript entries, nudge the agent host
  if (
    conv.events.length >= TRANSCRIPT_KICK_EVENT_THRESHOLD &&
    !ctx.transcriptCache.has(conversationId) &&
    conv.status !== 'ended'
  ) {
    if (ctx.transcriptKickDebouncer.shouldNotify(conversationId)) {
      const wrappers = ctx.conversationSockets.get(conversationId)
      if (wrappers) {
        for (const ws of wrappers.values()) {
          try {
            ws.send(JSON.stringify({ type: 'transcript_kick', conversationId }))
            console.log(`[conversation-store] Sent transcript_kick to wrapper for ${conversationId.slice(0, 8)}`)
          } catch {
            // Wrapper socket may be dead
          }
        }
      }
    }
  }

  // Coalesce conversation update (for lastActivity, eventCount changes)
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
  conv: Conversation,
  event: HookEvent,
) => void

function dispatchSessionStart(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  const sessionStartEvent = event as HookEventOf<'SessionStart'>
  handleSessionStart(conv, sessionStartEvent)
  handleCompactEvent(ctx, conversationId, conv, sessionStartEvent)
}

function dispatchCompact(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleCompactEvent(ctx, conversationId, conv, event as HookEventOf<'PreCompact' | 'PostCompact' | 'SessionStart'>)
}

function dispatchPreToolUse(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handlePreToolUse(ctx, conversationId, conv, event as HookEventOf<'PreToolUse'>)
}

function dispatchPermissionRequest(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handlePermissionRequest(conv, event as HookEventOf<'PermissionRequest'>)
}

function dispatchPermissionDenied(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handlePermissionDenied(ctx, conversationId, conv, event as HookEventOf<'PermissionDenied'>)
}

function dispatchElicitation(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleElicitation(conv, event as HookEventOf<'Elicitation'>)
}

function dispatchPostToolUse(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  clearPendingAttention(conv)
  handlePostToolUseTracking(conv, event as HookEventOf<'PostToolUse'>)
}

function dispatchClearPendingAttention(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  _event: HookEvent,
): void {
  clearPendingAttention(conv)
}

function dispatchSubagentStart(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleSubagentStart(ctx, conversationId, conv, event as HookEventOf<'SubagentStart'>)
}

function dispatchSubagentStop(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleSubagentStop(conv, event as HookEventOf<'SubagentStop'>)
}

function dispatchTeammateIdle(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleTeammateIdle(conv, event as HookEventOf<'TeammateIdle'>)
}

function dispatchTaskCompleted(
  _ctx: ConversationStoreContext,
  _conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleTaskCompleted(conv, event as HookEventOf<'TaskCompleted'>)
}

function dispatchNotification(
  ctx: ConversationStoreContext,
  conversationId: string,
  conv: Conversation,
  event: HookEvent,
): void {
  handleNotification(ctx, conversationId, conv, event as HookEventOf<'Notification'>)
}

const eventHandlers: Partial<Record<HookEventType, EventHandler>> = {
  SessionStart: dispatchSessionStart,
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
