/**
 * Message handlers for the stream-json backend.
 * Each function handles one top-level message type from CC's NDJSON output.
 */

import { createHash } from 'node:crypto'
import type { TranscriptEntry } from '../shared/protocol'
import { debug as _debug } from './debug'
import type {
  ControlRequestResult,
  StreamBackendOptions,
  StreamInitMessage,
  StreamResultMessage,
} from './stream-backend'
import { deriveMonitorOutputPath, type MonitorTracker } from './stream-monitors'
import { flushReplayBuffer, type ReplayBuffer } from './stream-replay'

const debug = (msg: string) => _debug(`[stream] ${msg}`)

function deterministicUuid(key: string): string {
  const h = createHash('sha1').update(key).digest('hex')
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-${((Number.parseInt(h[16], 16) & 0x3) | 0x8).toString(16)}${h.slice(17, 20)}-${h.slice(20, 32)}`
}

/**
 * Resolve an inline-agent `parent_tool_use_id` (the Task tool_use id carried by
 * assistant/user/system subagent entries) to its agent scope (the task id used
 * as the durable agentId). Falls back to the tool_use id itself when the
 * task_started mapping is missing -- e.g. after a host reconnect/revival emptied
 * the map. The fallback guarantees the entry is still agent-scoped (never leaks
 * to the parent stream, never silently dropped), matching the Checkpoint A
 * containment contract.
 */
function resolveAgentScope(hctx: HandlerContext, parentToolUseId: string): string {
  return hctx.monitors.agentToolUseToTask.get(parentToolUseId) ?? parentToolUseId
}

export interface HandlerContext {
  monitors: MonitorTracker
  replay: ReplayBuffer
  pendingControlRequests: Map<string, { subtype: string; detail?: string }>
  /** Resolvers for generic debug control_requests (full response back to caller). */
  controlRequestResolvers?: Map<string, (r: ControlRequestResult) => void>
  syntheticUserUuids?: Map<string, string>
  conversationId?: string
  callbacks: Pick<
    StreamBackendOptions,
    | 'onTranscriptEntries'
    | 'onInit'
    | 'onResult'
    | 'onPermissionRequest'
    | 'onStreamEvent'
    | 'onRateLimitStatus'
    | 'onTaskStarted'
    | 'onSubagentEntry'
    | 'onMonitorUpdate'
    | 'onScheduledTaskFire'
    | 'onAuthNeeded'
    | 'onPlanModeChanged'
    | 'onApiStatus'
    | 'onThinkingProgress'
    | 'onCommandsChanged'
  >
}

function extractSystemFields(msg: Record<string, unknown>): Record<string, unknown> {
  const { type: _t, subtype: _s, session_id: _sid, ...rest } = msg
  return rest
}

export function handleMessage(hctx: HandlerContext, msg: Record<string, unknown>) {
  const type = msg.type as string

  switch (type) {
    case 'system':
      handleSystem(hctx, msg)
      break
    case 'assistant':
      handleAssistant(hctx, msg)
      break
    case 'user':
      handleUser(hctx, msg)
      break
    case 'control_request':
      handleControlRequest(hctx, msg)
      break
    case 'control_response':
      handleControlResponse(hctx, msg)
      break
    case 'result':
      handleResult(hctx, msg)
      break
    case 'stream_event':
      handleStreamEvent(hctx, msg)
      break
    case 'rate_limit_event':
      handleRateLimitEvent(hctx, msg)
      break
    case 'queue-operation':
      handleQueueOperation(hctx, msg)
      break
    default:
      debug(`Unknown message type: ${type}`)
  }
}

function handleSystem(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { replay, callbacks } = hctx
  const subtype = msg.subtype as string
  const ts = new Date().toISOString()

  if (subtype === 'init') {
    debug(`init: session=${(msg.session_id as string)?.slice(0, 8)} model=${msg.model}`)
    callbacks.onInit?.(msg as unknown as StreamInitMessage)
    // CC reports permissionMode in init too, not just in the 'status' subtype.
    // Without this, sessions that boot directly into plan (--permission-mode plan,
    // revived plan-mode session) get the permission_mode_changed launch event but
    // never flip conversation.planMode, so the UI's PLAN state stays off.
    const initPermMode = msg.permissionMode as string | undefined
    if (initPermMode && callbacks.onPlanModeChanged) {
      callbacks.onPlanModeChanged(initPermMode === 'plan')
    }
    return
  }

  if (subtype === 'task_started') {
    handleTaskStarted(hctx, msg)
    return
  }

  if (subtype === 'hook_started' || subtype === 'hook_response') return

  // Backend-agnostic thinking-progress ping. EPHEMERAL: handed off to the
  // onThinkingProgress callback (which the agent host forwards as a
  // ThinkingProgress wire message), but explicitly NOT persisted as a
  // TranscriptEntry. CC emits these every ~1.5s while in extended thinking;
  // turning them into transcript entries would flood the store + UI with
  // noise for what is purely a liveness cue.
  if (subtype === 'thinking_tokens') {
    const tokens = typeof msg.estimated_tokens === 'number' ? msg.estimated_tokens : 0
    const delta = typeof msg.estimated_tokens_delta === 'number' ? msg.estimated_tokens_delta : undefined
    callbacks.onThinkingProgress?.({ tokens, delta })
    return
  }

  // CC's mid-session push update for the `/` command-completion catalog (it
  // fires when skills/commands load lazily or after a reload). The list is the
  // authoritative `/` menu set; we hand the names to onCommandsChanged so the
  // agent host can refresh conversation_info. NOT persisted as a transcript
  // entry -- the raw payload is the full catalog (multi-KB), and the broker
  // already emits a structured `slash_*` launch entry when the list diffs.
  //
  // NOTE: msg.commands carries MORE than names -- each entry has `description`
  // and `argumentHint`. We only forward names for now (matches today's
  // autocomplete). Carrying the richer data through to a description-annotated
  // `/` menu is deliberately out of scope here; wire it later if wanted.
  if (subtype === 'commands_changed') {
    const commands = Array.isArray(msg.commands) ? (msg.commands as Array<{ name?: unknown }>) : []
    const names = commands.map(c => c?.name).filter((n): n is string => typeof n === 'string')
    debug(`commands_changed: ${names.length} commands`)
    callbacks.onCommandsChanged?.(names)
    return
  }

  // Advisor tool events (CC 2.1.170 server-side advisor tool). A worker can call
  // advisor() to consult a stronger model (Fable); CC streams advisor_message /
  // advisor_result / advisor_tool_result / advisor_redacted_result /
  // advisor_tool_result_error. Fold each into a dedicated 'advisor' transcript
  // entry (a card) rather than the raw system blob the generic fallback emits.
  if (typeof subtype === 'string' && subtype.startsWith('advisor')) {
    handleAdvisorEvent(hctx, msg, subtype, ts)
    return
  }

  if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)

  const systemEntry = {
    type: 'system' as const,
    subtype,
    timestamp: ts,
    ...extractSystemFields(msg),
  } as TranscriptEntry

  const sysParentToolUseId = msg.parent_tool_use_id as string | null
  if (sysParentToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(resolveAgentScope(hctx, sysParentToolUseId), systemEntry)
    return
  }

  const routedToSubagent = handleSystemSubtype(hctx, subtype, msg, systemEntry)

  if (!routedToSubagent) {
    callbacks.onTranscriptEntries?.([systemEntry], false)
  }
}

/** Normalize a CC advisor_* event into a dedicated 'advisor' transcript entry.
 *  Defensive about the payload shape (live-verification pending): pulls the
 *  advice text from content.text / content / text, the model from
 *  advisor_model / model, and preserves the raw payload for the inspector. */
function pickString(...values: unknown[]): string | undefined {
  for (const v of values) if (typeof v === 'string' && v) return v
  return undefined
}

function extractAdvisorText(msg: Record<string, unknown>): string | undefined {
  const content = msg.content
  if (typeof content === 'string') return content
  const nested = (content as { text?: unknown } | null | undefined)?.text
  return pickString(nested, msg.text)
}

function handleAdvisorEvent(hctx: HandlerContext, msg: Record<string, unknown>, subtype: string, ts: string) {
  const { replay, callbacks } = hctx
  if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)

  const advisorEntry = {
    type: 'advisor' as const,
    advisorSubtype: subtype.replace(/^advisor_/, '') || subtype,
    text: extractAdvisorText(msg),
    // CC's binary carries the advisor model as camelCase `advisorModel`; accept
    // both casings (+ the generic `model`) since the exact stream-json envelope
    // is unverified pending a live Fable advisor run.
    advisorModel: pickString(msg.advisor_model, msg.advisorModel, msg.model),
    redacted: subtype === 'advisor_redacted_result' || undefined,
    isError: subtype === 'advisor_tool_result_error' || undefined,
    timestamp: ts,
    raw: extractSystemFields(msg),
  } as TranscriptEntry

  const parentToolUseId = msg.parent_tool_use_id as string | null
  if (parentToolUseId && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(resolveAgentScope(hctx, parentToolUseId), advisorEntry)
    return
  }
  callbacks.onTranscriptEntries?.([advisorEntry], false)
}

function handleTaskStarted(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, callbacks } = hctx
  const taskType = msg.task_type as string
  const taskId = msg.task_id as string
  const toolUseId = msg.tool_use_id as string
  const description = (msg.description as string) || ''
  debug(`task_started: ${taskType} id=${taskId?.slice(0, 8)} ${description.slice(0, 40)}`)

  if (taskType === 'local_agent' && taskId && toolUseId) {
    monitors.agentToolUseToTask.set(toolUseId, taskId)
  } else if (taskId && toolUseId) {
    const cached = monitors.pendingMonitorInputs.get(toolUseId)
    const monitorInfo = {
      toolUseId,
      description: cached?.description || description,
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs,
      eventCount: 0,
    }
    monitors.monitorTasks.set(taskId, monitorInfo)
    monitors.pendingMonitorInputs.delete(toolUseId)
    debug(`monitor_started: ${taskId.slice(0, 8)} "${monitorInfo.description.slice(0, 40)}"`)
    callbacks.onMonitorUpdate?.({
      taskId,
      ...monitorInfo,
      status: 'running',
      outputPath: deriveMonitorOutputPath(monitorInfo.command, taskId),
    })
  }
  callbacks.onTaskStarted?.({ taskId, toolUseId, taskType, description })
}

/** A `system/api_retry` with `error_status: 401` means the profile's auth is
 *  dead. Surface the re-login hint ONCE per failing request (gate on the first
 *  retry attempt) -- attempts 2..N are the same episode, and a genuinely new
 *  failing turn starts back at 1. */
function surfaceAuthNeededOnUnauthorized(
  callbacks: { onAuthNeeded?: (info: { errorStatus: number; detail?: string }) => void },
  msg: Record<string, unknown>,
): void {
  const errorStatus = Number(msg.error_status) || 0
  const attempt = Number(msg.attempt) || 0
  if (errorStatus === 401 && attempt <= 1) {
    callbacks.onAuthNeeded?.({ errorStatus, detail: typeof msg.error === 'string' ? msg.error : undefined })
  }
}

function handleSystemSubtype(
  hctx: HandlerContext,
  subtype: string,
  msg: Record<string, unknown>,
  systemEntry: TranscriptEntry,
): boolean {
  const { callbacks } = hctx
  let routedToSubagent = false

  switch (subtype) {
    case 'local_command_output':
      debug(`local_command_output: ${((msg.content as string) || '').slice(0, 80)}`)
      ;(systemEntry as Record<string, unknown>).subtype = 'local_command'
      break
    case 'api_retry':
      debug(
        `api_retry: attempt=${msg.attempt}/${msg.max_retries} delay=${msg.retry_delay_ms}ms status=${msg.error_status}`,
      )
      surfaceAuthNeededOnUnauthorized(callbacks, msg)
      break
    case 'informational':
      debug(`informational: ${((msg.content as string) || '').slice(0, 80)}`)
      break
    case 'compact_boundary':
      debug('compact_boundary')
      break
    case 'session_state_changed':
      debug(`session_state_changed: ${msg.state}`)
      break
    case 'task_notification':
      routedToSubagent = handleTaskNotification(hctx, msg, systemEntry)
      break
    case 'task_progress':
      routedToSubagent = handleTaskProgress(hctx, msg, systemEntry)
      break
    case 'turn_duration':
      debug(`turn_duration: ${JSON.stringify(msg.duration_ms ?? msg)}`)
      break
    case 'memory_saved':
      debug('memory_saved')
      break
    case 'agents_killed':
      debug('agents_killed')
      break
    case 'permission_retry':
      debug(`permission_retry: ${msg.content}`)
      break
    case 'post_turn_summary':
      debug(`post_turn_summary: ${msg.status_category} "${(msg.title as string)?.slice(0, 40)}"`)
      break
    case 'scheduled_task_fire':
      debug(`scheduled_task_fire: ${msg.content}`)
      callbacks.onScheduledTaskFire?.((msg.content as string) || '')
      break
    case 'status':
      handleStatusSubtype(hctx, msg)
      break
    default:
      debug(`system/${subtype}: ${JSON.stringify(msg).slice(0, 120)}`)
      break
  }

  return routedToSubagent
}

function handleTaskNotification(
  hctx: HandlerContext,
  msg: Record<string, unknown>,
  systemEntry: TranscriptEntry,
): boolean {
  const { monitors, callbacks } = hctx
  const notifTaskId = msg.task_id as string
  const notifStatus = msg.status as string
  debug(`task_notification: task=${notifTaskId} status=${notifStatus}`)

  // A task id is either a Monitor task or an inline-agent task -- never both.
  // Monitor notifications keep their existing parent-stream behavior; anything
  // else is agent-scoped (see handleTaskProgress for the containment rationale).
  const notifMonitor = monitors.monitorTasks.get(notifTaskId)
  if (notifMonitor) {
    notifMonitor.eventCount++
    const terminalStatus =
      notifStatus === 'completed'
        ? 'completed'
        : notifStatus === 'failed'
          ? 'failed'
          : notifStatus === 'timed_out'
            ? 'timed_out'
            : null
    if (terminalStatus) {
      monitors.monitorTasks.delete(notifTaskId)
    }
    callbacks.onMonitorUpdate?.({
      taskId: notifTaskId,
      ...notifMonitor,
      status: (terminalStatus as 'completed' | 'failed' | 'timed_out') || 'running',
    })
    return false
  }

  callbacks.onSubagentEntry?.(notifTaskId, systemEntry)
  return true
}

function handleTaskProgress(hctx: HandlerContext, msg: Record<string, unknown>, systemEntry: TranscriptEntry): boolean {
  const { monitors, callbacks } = hctx
  const progressTaskId = msg.task_id as string
  debug(`task_progress: task=${progressTaskId} tokens=${(msg.usage as Record<string, unknown>)?.total_tokens}`)

  // Monitor progress stays in the parent stream (unchanged). Every other
  // task_progress is inline-agent chatter: route it to the agent scope keyed by
  // task_id and return true so handleSystem NEVER falls it through to the parent
  // -- the containment fix for the 52b5f3ec empty-transcript leak. No agent map
  // lookup is needed: the task id IS the agent scope, so an emptied map (host
  // reconnect/revival) can no longer re-leak progress into the parent.
  const progressMonitor = monitors.monitorTasks.get(progressTaskId)
  if (progressMonitor) {
    progressMonitor.eventCount++
    return false
  }

  callbacks.onSubagentEntry?.(progressTaskId, systemEntry)
  return true
}

function handleStatusSubtype(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { callbacks } = hctx
  const apiStatus = msg.status as string | undefined
  const permMode = msg.permissionMode as string | undefined
  debug(`status: ${apiStatus || 'unknown'} permissionMode=${permMode}`)
  if (apiStatus) callbacks.onApiStatus?.(apiStatus)
  if (permMode && callbacks.onPlanModeChanged) {
    callbacks.onPlanModeChanged(permMode === 'plan')
  }
}

/**
 * Routes a transcript entry through subagent, replay, or live emission.
 * Shared by handleAssistant and handleUser to avoid duplicating the
 * three-branch routing conditional.
 */
function routeEntry(
  replay: ReplayBuffer,
  callbacks: HandlerContext['callbacks'],
  msg: Record<string, unknown>,
  parentToolUseId: string | null,
  entry: TranscriptEntry,
  agentScope: string | null,
) {
  if (parentToolUseId && agentScope && callbacks.onSubagentEntry) {
    callbacks.onSubagentEntry(agentScope, entry)
  } else if (msg.isReplay) {
    if (!replay.done) replay.entries.push(entry)
  } else {
    if (!replay.done) flushReplayBuffer(replay, callbacks.onTranscriptEntries)
    callbacks.onTranscriptEntries?.([entry], false)
  }
}

function handleAssistant(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, replay, callbacks } = hctx
  const parentToolUseId = msg.parent_tool_use_id as string | null

  cacheMonitorInputs(monitors, msg)

  const ts = (msg.timestamp as string) || new Date().toISOString()
  const uuid = (msg.uuid as string) || deterministicUuid(`assistant:${ts}:${JSON.stringify(msg.message).slice(0, 200)}`)
  const entry = {
    type: 'assistant' as const,
    timestamp: ts,
    message: msg.message,
    uuid,
  } as TranscriptEntry

  const agentScope = parentToolUseId ? resolveAgentScope(hctx, parentToolUseId) : null
  routeEntry(replay, callbacks, msg, parentToolUseId, entry, agentScope)
}

function cacheMonitorInputs(monitors: MonitorTracker, msg: Record<string, unknown>) {
  const assistantMsg = msg.message as { content?: Array<Record<string, unknown>> } | undefined
  if (!assistantMsg?.content) return

  for (const block of assistantMsg.content) {
    if (block.type === 'tool_use' && block.name === 'Monitor' && block.id) {
      const inp = block.input as Record<string, unknown> | undefined
      if (inp) {
        monitors.pendingMonitorInputs.set(block.id as string, {
          command: inp.command as string | undefined,
          persistent: inp.persistent as boolean | undefined,
          timeoutMs: (inp.timeout_ms as number | undefined) ?? (inp.timeoutMs as number | undefined),
          description: inp.description as string | undefined,
        })
      }
    }
  }
}

function handleUser(hctx: HandlerContext, msg: Record<string, unknown>) {
  const { monitors, replay, callbacks } = hctx
  const parentToolUseId = msg.parent_tool_use_id as string | null

  extractMonitorFromToolResult(monitors, callbacks, msg)
  detectMonitorNotifications(monitors, callbacks, msg)

  const ts = (msg.timestamp as string) || new Date().toISOString()
  const messageContent = (msg.message as { content?: unknown })?.content
  const isToolResult = Array.isArray(messageContent)

  // For plain text user messages, check if sendUserMessage stashed a UUID.
  // Reusing it ensures the broker deduplicates the CC echo (displaced arrival)
  // against the synthetic (correct position) via INSERT OR IGNORE.
  let uuid = msg.uuid as string | undefined
  if (!uuid && !isToolResult && hctx.syntheticUserUuids) {
    const content = typeof messageContent === 'string' ? messageContent : ''
    const contentHash = createHash('sha1').update(content).digest('hex').slice(0, 16)
    const stashed = hctx.syntheticUserUuids.get(contentHash)
    if (stashed) {
      uuid = stashed
      hctx.syntheticUserUuids.delete(contentHash)
    }
  }
  if (!uuid) {
    uuid = deterministicUuid(`user:${ts}:${JSON.stringify(msg.message).slice(0, 200)}`)
  }

  const entry = {
    type: 'user' as const,
    timestamp: ts,
    message: msg.message,
    uuid,
  } as TranscriptEntry

  if (msg.tool_use_result) {
    ;(entry as Record<string, unknown>).toolUseResult = msg.tool_use_result
  }

  // Normalize CC's meta-entry marker onto our canonical `isMeta`. CC's two
  // transcript dialects name it differently: the JSONL (PTY path) uses
  // `isMeta`, the stdout stream-json (headless path) uses `isSynthetic`. Both
  // mark the same thing -- an injected, non-user-turn entry (skill content,
  // injected context). Without this, headless transcripts drop the marker
  // entirely and every downstream `isMeta` consumer silently breaks.
  if (msg.isMeta === true || msg.isSynthetic === true) {
    ;(entry as Record<string, unknown>).isMeta = true
  }

  const agentScope = parentToolUseId ? resolveAgentScope(hctx, parentToolUseId) : null
  routeEntry(replay, callbacks, msg, parentToolUseId, entry, agentScope)
}

function extractMonitorFromToolResult(
  monitors: MonitorTracker,
  callbacks: HandlerContext['callbacks'],
  msg: Record<string, unknown>,
) {
  const userMsg = msg.message as { content?: string | Array<Record<string, unknown>> } | undefined
  if (!userMsg?.content || !Array.isArray(userMsg.content)) return

  for (const block of userMsg.content) {
    if (block.type !== 'tool_result' || typeof block.content !== 'string') continue

    const toolUseId = block.tool_use_id as string
    const monitorMatch = (block.content as string).match(/^Monitor started \(task (\w+), timeout (\d+)ms\)/)
    if (!monitorMatch || !toolUseId) continue

    const taskId = monitorMatch[1]
    const cached = monitors.pendingMonitorInputs.get(toolUseId)
    monitors.monitorTasks.set(taskId, {
      toolUseId,
      description: cached?.description || '',
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs ?? Number.parseInt(monitorMatch[2], 10),
      eventCount: 0,
    })
    monitors.pendingMonitorInputs.delete(toolUseId)
    debug(`monitor_started (from result): ${taskId.slice(0, 8)} "${cached?.description?.slice(0, 40) || ''}"`)
    callbacks.onMonitorUpdate?.({
      taskId,
      toolUseId,
      description: cached?.description || '',
      command: cached?.command,
      persistent: cached?.persistent,
      timeoutMs: cached?.timeoutMs ?? Number.parseInt(monitorMatch[2], 10),
      status: 'running',
      eventCount: 0,
      outputPath: deriveMonitorOutputPath(cached?.command, taskId),
    })
  }
}

function detectMonitorNotifications(
  monitors: MonitorTracker,
  callbacks: HandlerContext['callbacks'],
  msg: Record<string, unknown>,
) {
  const userMsg = msg.message as { content?: string | Array<Record<string, unknown>> } | undefined
  const userContent =
    typeof userMsg?.content === 'string'
      ? userMsg.content
      : Array.isArray(userMsg?.content)
        ? userMsg.content
            .filter((b): b is { text: string } => typeof (b as Record<string, unknown>).text === 'string')
            .map(b => b.text)
            .join('')
        : ''

  if (!userContent.includes('<task-notification>')) return

  const taskIdMatch = userContent.match(/<task-id>(\w+)<\/task-id>/)
  const eventMatch = userContent.match(/<event>([\s\S]*?)<\/event>/)
  if (!taskIdMatch) return

  const notifTaskId = taskIdMatch[1]
  const monitor = monitors.monitorTasks.get(notifTaskId)
  if (!monitor) return

  monitor.eventCount++
  const isTimeout = eventMatch?.[1]?.includes('timed out')
  if (isTimeout) {
    monitors.monitorTasks.delete(notifTaskId)
    callbacks.onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'timed_out' })
    debug(`monitor_timed_out: ${notifTaskId.slice(0, 8)}`)
  } else {
    callbacks.onMonitorUpdate?.({ taskId: notifTaskId, ...monitor, status: 'running' })
  }
}

function handleControlRequest(hctx: HandlerContext, msg: Record<string, unknown>) {
  const request = msg.request as Record<string, unknown> | undefined
  if (!request) return

  const subtype = request.subtype as string
  if (subtype !== 'can_use_tool') return

  const toolName = (request.tool_name as string) || ''
  const toolInput = (request.input as Record<string, unknown>) || {}
  const requestId = (msg.request_id as string) || (request.request_id as string) || ''
  debug(`Permission request: ${toolName} (${requestId}) reason=${request.decision_reason || ''}`)
  hctx.callbacks.onPermissionRequest?.({
    requestId,
    toolName,
    toolInput,
    ...request,
  })
}

function handleControlResponse(hctx: HandlerContext, msg: Record<string, unknown>) {
  const response = msg.response as Record<string, unknown> | undefined
  if (!response) return

  const requestId = (response.request_id as string) || ''
  const subtype = response.subtype as string
  debug(`control_response: ${requestId} subtype=${subtype}`)

  // Generic debug control_request: resolve the caller's promise with the full
  // response (success OR error) before the set_model/perm-mode notice logic.
  const resolver = hctx.controlRequestResolvers?.get(requestId)
  if (resolver) {
    hctx.controlRequestResolvers?.delete(requestId)
    resolver({
      ok: subtype === 'success',
      subtype,
      response: response.response,
      error: typeof response.error === 'string' ? response.error : undefined,
    })
    return
  }

  const pending = hctx.pendingControlRequests.get(requestId)
  hctx.pendingControlRequests.delete(requestId)
  if (!pending || subtype !== 'success') return

  let text: string | null = null
  if (pending.subtype === 'set_model') {
    text = pending.detail ? `Model changed to ${pending.detail}` : 'Model changed'
  } else if (pending.subtype === 'set_permission_mode') {
    text = pending.detail ? `Permission mode: ${pending.detail}` : 'Permission mode changed'
  }

  if (!text) return

  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  const entry = {
    type: 'system' as const,
    subtype: 'informational',
    timestamp: new Date().toISOString(),
    content: text,
  } as TranscriptEntry
  hctx.callbacks.onTranscriptEntries?.([entry], false)
}

function handleResult(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  debug(`Result: ${msg.subtype} cost=$${msg.total_cost_usd} turns=${msg.num_turns}`)
  hctx.callbacks.onResult?.(msg as unknown as StreamResultMessage)
}

function handleStreamEvent(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  hctx.callbacks.onStreamEvent?.((msg.event as Record<string, unknown>) || msg)
}

function handleRateLimitEvent(hctx: HandlerContext, msg: Record<string, unknown>) {
  const info = msg.rate_limit_info as Record<string, unknown> | undefined
  const isAllowed = info?.status === 'allowed'
  const rateLimitType = info?.rateLimitType as string | undefined
  // resetsAt arrives from CC in seconds; normalize to epoch ms for downstream consumers.
  const resetsAtRaw = info?.resetsAt as number | undefined
  const resetsAt = resetsAtRaw && resetsAtRaw < 1e12 ? resetsAtRaw * 1000 : resetsAtRaw
  // Pass retry_after_ms through if CC sent it. NO synthetic default -- absence
  // means this is a NOTICE (e.g. 7-day soft warning), not an actual block.
  const retryMs = isAllowed ? undefined : (msg.retry_after_ms as number | undefined)
  // Plan utilization (0-1) for the REPRESENTATIVE window named by rateLimitType.
  // Rides on inference traffic for FREE -- the broker folds it into the per-profile
  // usage store so the bars stay truthful even when the dedicated /api/oauth/usage
  // poll is 429'd (a per-token throttle on the shared default login). See
  // `src/broker/conversation-store/usage-merge.ts`.
  const utilization = typeof info?.utilization === 'number' ? info.utilization : undefined

  debug(
    `Rate limit status: ${isAllowed ? 'allowed' : 'limited'}${rateLimitType ? ` (${rateLimitType})` : ''}${utilization != null ? ` util=${Math.round(utilization * 100)}%` : ''}${retryMs ? ` retry=${retryMs}ms` : ' (notice)'}`,
  )

  hctx.callbacks.onRateLimitStatus?.({
    status: isAllowed ? 'allowed' : 'limited',
    retryAfterMs: retryMs,
    rateLimitType,
    resetsAt,
    utilization,
    raw: msg,
  })
}

function handleQueueOperation(hctx: HandlerContext, msg: Record<string, unknown>) {
  if (!hctx.replay.done) flushReplayBuffer(hctx.replay, hctx.callbacks.onTranscriptEntries)
  const entry = {
    type: 'queue-operation' as const,
    timestamp: (msg.timestamp as string) || new Date().toISOString(),
    operation: msg.operation as string,
    ...(msg.content ? { content: msg.content as string } : {}),
  } as TranscriptEntry
  debug(`queue-operation: ${msg.operation}${msg.content ? ` "${(msg.content as string).slice(0, 40)}"` : ''}`)
  hctx.callbacks.onTranscriptEntries?.([entry], false)
}
