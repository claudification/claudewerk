/**
 * Hook forwarding seam.
 *
 * Owns the last step of the hook pipeline: stamp the stable conversationId +
 * subagent attribution onto an outgoing HookEvent, then forward it to the
 * broker (or queue it until the WS + CC session id are ready).
 *
 * Subagent attribution is the containment fix for the systemic mis-attribution
 * bug: the broker must keep a subagent's side effects off the parent, but the
 * two are indistinguishable to it without an explicit marker. CC stamps
 * `agent_id` (+ `agent_type`) on every hook a subagent raises and omits both on
 * the parent's own hooks, so the agent host just relays that discriminant as
 * `HookEvent.subagentId`. See plan-subagent-hook-containment.md.
 */

import type { HookEvent } from '../shared/protocol'
import type { AgentHostContext } from './agent-host-context'
import { debug as _debug } from './debug'

const debug = (msg: string) => _debug(msg)

const MAX_EVENT_QUEUE = 200

/** Roster/lifecycle hooks the broker needs to build and tear down its subagent +
 *  teammate rosters on the PARENT conversation. They carry an `agent_id` (it
 *  names the subagent they are ABOUT), but tagging them subagent-originated
 *  would make the broker skip the very handler that registers/updates the
 *  roster. Always parent-routed. */
const ROSTER_LIFECYCLE_HOOKS = new Set(['SubagentStart', 'SubagentStop', 'TeammateIdle', 'TaskCompleted'])

/**
 * Decide whether a hook about to be forwarded came from a subagent, and if so
 * which one. Returns the subagent's agent_id (the conv.subagents roster key) or
 * undefined for parent-originated hooks.
 *
 * CC stamps `agent_id` + `agent_type` on the hooks a subagent raises for its own
 * tool calls, and omits both on the parent's -- including on the parent's own
 * Agent/Task spawn call, which is why that needs no special case here. So the
 * payload is an exact discriminant and also names the RIGHT sibling when several
 * subagents run concurrently.
 *
 * This deliberately does NOT consult ctx.runningSubagents. The previous
 * implementation inferred attribution from the SubagentStart..SubagentStop
 * window, on the premise that the parent turn was suspended inside the Task tool
 * and issued no hooks of its own. CC 2.1.198 made subagents run in the
 * BACKGROUND by default, so the parent keeps working through that window and had
 * its own tool hooks tagged with the subagent's id -- measured at 5-6
 * misattributed parent hooks per run on CC 2.1.209, which the broker then
 * contained off the parent conversation (see add-event.ts). Window-free
 * attribution is also immune to a hook that lands after SubagentStop.
 */
export function resolveSubagentAttribution(event: HookEvent): string | undefined {
  if (ROSTER_LIFECYCLE_HOOKS.has(event.hookEvent)) return undefined
  const agentId = (event.data as { agent_id?: unknown }).agent_id
  return typeof agentId === 'string' && agentId.length > 0 ? agentId : undefined
}

/**
 * Stamp attribution + the stable conversationId, then forward the event to the
 * broker or queue it until the session id + WS are ready. The attributed event
 * is what gets queued, so the flush in broker-connection.ts preserves it.
 */
export function forwardOrQueueHookEvent(ctx: AgentHostContext, event: HookEvent): void {
  const subagentId = resolveSubagentAttribution(event)
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
