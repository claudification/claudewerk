/**
 * THE GATE on the agent-facing schedule surface, and the reply envelope.
 *
 * A schedule is a spawn that fires later with nobody watching, so what an agent
 * may do is deliberately narrower than what the control panel may do:
 *
 *   - WRITES require BENEVOLENT trust. The interactive spawn-approval dialog
 *     cannot help here -- it exists so a HUMAN can vet a spawn, and the entire
 *     point of a schedule is that it fires when no human is present. So an
 *     untrusted conversation may not arm one at all.
 *   - READS are scoped to the caller's OWN project. The schedules of the project
 *     you are already working in tell you nothing you could not read off disk;
 *     enumerating every OTHER project's unattended work is a different thing,
 *     and needs benevolent trust.
 *
 * The caller's project always comes from the BROKER's view of its connection,
 * never from the wire body, so a host cannot ask about a project it does not
 * own by simply naming it.
 */

import { isSameProject } from '../../shared/project-uri'
import type { ScheduledTask } from '../../shared/scheduled-task'
import type { HandlerContext, MessageData } from '../handler-context'
import { detectRole } from '../message-router'
import { broadcastScheduledTasks } from '../scheduled-tasks/broadcast'

export function respond(ctx: HandlerContext, data: MessageData, payload: Record<string, unknown>): void {
  const requestId = typeof data.requestId === 'string' ? data.requestId : ''
  ctx.reply({ type: 'schedule_result', requestId, ...payload })
}

export function fail(ctx: HandlerContext, data: MessageData, error: string): void {
  respond(ctx, data, { ok: false, error })
}

/** Benevolent trust: required for every write, and to look outside your own project. */
export function isBenevolent(ctx: HandlerContext): boolean {
  return detectRole(ctx.ws.data) !== 'agent-host' || ctx.callerSettings?.trustLevel === 'benevolent'
}

/** The caller's own project, from the broker's view of its connection. */
function callerProject(ctx: HandlerContext): string | null {
  const convId = ctx.ws.data.conversationId
  const project = (convId ? ctx.conversations.getConversation(convId)?.project : undefined) ?? ctx.caller?.project
  return project ?? null
}

/**
 * Which project a READ may cover. An absent `project` means EVERY project,
 * which only a benevolent caller is ever given. Naming someone else's project
 * is refused outright rather than silently narrowed -- a quiet narrowing reads
 * as "that project has no schedules", which is a different and wrong answer.
 */
export function readScope(ctx: HandlerContext, data: MessageData): { project?: string } | { error: string } {
  const asked = typeof data.projectUri === 'string' ? data.projectUri.trim() : ''
  if (isBenevolent(ctx)) return asked ? { project: asked } : {}

  const own = callerProject(ctx)
  if (!own) return { error: 'no resolvable project for this conversation' }
  if (asked && !isSameProject(asked, own)) {
    return { error: "reading another project's schedules requires benevolent trust" }
  }
  return { project: own }
}

/** The schedule a `/:id` request targets, or why it cannot be had. */
export function targetSchedule(ctx: HandlerContext, data: MessageData): { task: ScheduledTask } | { error: string } {
  const id = typeof data.id === 'string' ? data.id.trim() : ''
  if (!id) return { error: 'id is required' }
  const task = ctx.store.scheduledTasks.get(id)
  if (!task) return { error: `schedule "${id}" not found` }
  return { task }
}

/** Push the refreshed list to every dashboard, so a schedule an agent armed
 *  appears in the panel without a reload. */
export function announce(ctx: HandlerContext): void {
  broadcastScheduledTasks(ctx.conversations.getSubscribers(), ctx.store.scheduledTasks.list())
}

/** Short conversation id for the log lines -- every write says who did it. */
export function callerTag(ctx: HandlerContext): string {
  return ctx.ws.data.conversationId?.slice(0, 8) ?? '?'
}
