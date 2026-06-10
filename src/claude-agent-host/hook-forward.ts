/**
 * Hook forwarding seam.
 *
 * Owns the last step of the hook pipeline: stamp the stable conversationId +
 * subagent attribution onto an outgoing HookEvent, then forward it to the
 * broker (or queue it until the WS + CC session id are ready).
 *
 * Subagent attribution is the containment fix for the systemic mis-attribution
 * bug: in the current CC version every subagent (Task tool) hook carries the
 * PARENT session id and no subagent identifier, so the broker cannot tell
 * subagent hooks apart from the wire payload alone. The agent host -- which
 * brackets each subagent between SubagentStart/SubagentStop -- tags
 * subagent-originated hooks with the running subagent's agent_id; the broker
 * then keeps their side effects off the parent. See
 * plan-subagent-hook-containment.md and HookEvent.subagentId.
 */

import type { HookEvent } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug as _debug } from './debug'

const debug = (msg: string) => _debug(msg)

const MAX_EVENT_QUEUE = 200

/** Tool hooks (the ones carrying a `tool_name`). */
const TOOL_USE_HOOKS = new Set(['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])

/** Tools by which the PARENT drives a subagent. A Pre/PostToolUse for one of
 *  these is a PARENT event even while a sibling subagent runs, so it must never
 *  be tagged subagent-originated. */
const PARENT_SPAWN_TOOLS = new Set(['Agent', 'Task'])

/** Roster/lifecycle hooks the broker needs to build and tear down its subagent +
 *  teammate rosters on the PARENT conversation. They carry an agent_id and fire
 *  during the subagent window, but tagging them subagent-originated would make
 *  the broker skip the very handler that registers/updates the roster. Always
 *  parent-routed. */
const ROSTER_LIFECYCLE_HOOKS = new Set(['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted'])

/** True when the hook is the parent's own Agent/Task tool call (spawning or
 *  reaping a subagent) -- a parent event despite a running sibling subagent. */
function isParentSpawnToolHook(event: HookEvent): boolean {
  if (!TOOL_USE_HOOKS.has(event.hookEvent)) return false
  const toolName = (event.data as { tool_name?: unknown }).tool_name
  return PARENT_SPAWN_TOOLS.has(toolName as string)
}

/**
 * Decide whether a hook about to be forwarded came from a running subagent, and
 * if so which one. Returns the subagent's agent_id (the conv.subagents roster
 * key) or undefined for parent-originated hooks.
 *
 * Why a running-window heuristic and not payload correlation: in the current CC
 * version every subagent hook carries the PARENT session id and no subagent id
 * (`data.conversation_id` is absent; only SubagentStart/Stop carry `agent_id`).
 * The one reliable signal the agent host owns is the SubagentStart..SubagentStop
 * bracket. While >=1 subagent is in flight the parent turn is suspended inside
 * the Task tool and issues no tool hooks of its own -- so any hook in that window
 * (except the roster/lifecycle hooks themselves and the parent's own Agent/Task
 * tool hooks) is subagent-originated. With multiple subagents we cannot tell them
 * apart from the payload, so we attribute to the most-recently-started one:
 * containment off the parent matters more than picking the exact sibling.
 */
export function resolveSubagentAttribution(ctx: AgentHostContext, event: HookEvent): string | undefined {
  // Parent-originated hooks: roster/lifecycle (build/tear down the rosters), no
  // subagent in flight, or the parent's own Agent/Task tool hook.
  if (ROSTER_LIFECYCLE_HOOKS.has(event.hookEvent)) return undefined
  if (ctx.runningSubagents.size === 0 || isParentSpawnToolHook(event)) return undefined

  // Subagent-originated. Attribute to the most-recently-started running subagent
  // (Set preserves insertion order; the last entry is the newest).
  return Array.from(ctx.runningSubagents).at(-1)
}

/**
 * Stamp attribution + the stable conversationId, then forward the event to the
 * broker or queue it until the session id + WS are ready.
 *
 * Attribution is computed NOW, at observation time -- runningSubagents reflects
 * the live window here; a queued event may not flush until after the window
 * closed, so capturing it later would lose the attribution. The attributed event
 * is what gets queued, so the flush in broker-connection.ts preserves it.
 */
export function forwardOrQueueHookEvent(ctx: AgentHostContext, event: HookEvent): void {
  const subagentId = resolveSubagentAttribution(ctx, event)
  const outgoing: HookEvent = { ...event, conversationId: ctx.conversationId }
  if (subagentId) outgoing.subagentId = subagentId
  const tag = fmtSubagentTag(subagentId)

  const ws = ctx.wsClient
  if (ctx.claudeSessionId && ws?.isConnected()) {
    ws.sendHookEvent(outgoing)
    debug(`Hook: ${event.hookEvent} -> forwarded (sid=${ctx.claudeSessionId.slice(0, 8)}${tag})`)
    return
  }
  queueHookEvent(ctx, outgoing, tag)
}

/** Short ` subagent=<id7>` suffix for debug lines (empty for parent events). */
function fmtSubagentTag(subagentId: string | undefined): string {
  return subagentId ? ` subagent=${subagentId.slice(0, 7)}` : ''
}

/** Queue an (already-attributed) event until the WS + session id are ready,
 *  evicting the oldest when the bounded queue is full. */
function queueHookEvent(ctx: AgentHostContext, outgoing: HookEvent, tag: string): void {
  if (ctx.eventQueue.length >= MAX_EVENT_QUEUE) {
    const dropped = ctx.eventQueue.shift()
    debug(`Event queue full (${MAX_EVENT_QUEUE}), dropping oldest: ${dropped?.hookEvent}`)
  }
  ctx.eventQueue.push(outgoing)
  const sid = ctx.claudeSessionId ? ctx.claudeSessionId.slice(0, 8) : 'null'
  debug(`Hook: ${outgoing.hookEvent} -> QUEUED (sid=${sid} queue=${ctx.eventQueue.length}${tag})`)
}
