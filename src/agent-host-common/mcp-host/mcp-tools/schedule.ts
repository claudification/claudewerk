/**
 * SCHEDULE tools -- full CRUD over the unattended runs a project owns.
 *
 * The vocabulary is deliberate: these are SCHEDULES and RUNS, never "tasks".
 * `TaskCreate` in this same toolbelt makes a todo item; `schedule_create` arms a
 * spawn that fires at 03:00 whether or not anyone is watching. Naming them alike
 * is how an agent picks the wrong one.
 *
 * Every call is a broker RPC; the gate lives server-side
 * (`handlers/scheduled-tasks-mcp.ts`), never here. Writes need BENEVOLENT trust
 * and reads are scoped to the caller's own project, so a tool result saying
 * "requires benevolent trust level" is the system working, not a bug.
 *
 * Two defaults exist because the wrong value is silent and expensive:
 *   - the PROJECT + CWD come from the caller's own conversation, with any
 *     `.claude/worktrees/<name>` folded away -- a schedule pinned to a worktree
 *     outlives the worktree and then fires into a directory that is gone.
 *   - the TIMEZONE defaults to this HOST's zone, never the broker's (it runs
 *     UTC), and the result says which zone it used.
 */

import type { ScheduledRun } from '../../../shared/scheduled-run'
import type { ScheduledTask } from '../../../shared/scheduled-task'
import { brokerRpc, hasBrokerRpcSender } from './lib/broker-rpc'
import { errResult as err, notConnected } from './lib/results'
import { createBody, patchBody } from './schedule-body'
import { SCHEDULE_TOOL_SCHEMAS } from './schedule-defs'
import { renderRuns, renderSchedule, renderScheduleList } from './schedule-render'
import type { McpToolContext, ToolDef, ToolResult } from './types'

interface ScheduleReply extends Record<string, unknown> {
  schedules?: ScheduledTask[]
  schedule?: ScheduledTask
  runs?: ScheduledRun[]
  deleted?: string
}

function text(t: string): ToolResult {
  return { content: [{ type: 'text', text: t }] }
}

export function registerScheduleTools(ctx: McpToolContext): Record<string, ToolDef> {
  async function rpc(type: string, payload: Record<string, unknown>): Promise<ScheduleReply | ToolResult> {
    if (!hasBrokerRpcSender()) return notConnected()
    try {
      return await brokerRpc<ScheduleReply>(type, payload)
    } catch (caught) {
      return err(caught instanceof Error ? caught.message : String(caught))
    }
  }
  const failed = (r: ScheduleReply | ToolResult): r is ToolResult => 'content' in r

  return {
    schedule_list: {
      description: SCHEDULE_TOOL_SCHEMAS.list.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.list.inputSchema,
      async handle(p) {
        const r = await rpc('schedule_list_request', p.projectUri ? { projectUri: p.projectUri } : {})
        if (failed(r)) return r
        return text(renderScheduleList(r.schedules ?? []))
      },
    },

    schedule_get: {
      description: SCHEDULE_TOOL_SCHEMAS.get.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.get.inputSchema,
      async handle(p) {
        const r = await rpc('schedule_get_request', { id: p.id, runLimit: p.runLimit ? Number(p.runLimit) : 10 })
        if (failed(r)) return r
        if (!r.schedule) return err('schedule not found')
        return text(`${renderSchedule(r.schedule)}\n\nrecent runs:\n${renderRuns(r.runs ?? [])}`)
      },
    },

    schedule_create: {
      description: SCHEDULE_TOOL_SCHEMAS.create.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.create.inputSchema,
      async handle(p) {
        const body = createBody(ctx, p)
        if ('error' in body) return err(body.error as string)
        const r = await rpc('schedule_create_request', { schedule: body, ...(p.owner ? { owner: p.owner } : {}) })
        if (failed(r)) return r
        if (!r.schedule) return err('create returned no schedule')
        return text(`Armed.\n\n${renderSchedule(r.schedule)}`)
      },
    },

    schedule_update: {
      description: SCHEDULE_TOOL_SCHEMAS.update.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.update.inputSchema,
      async handle(p) {
        const patch = patchBody(p)
        if (Object.keys(patch).length === 0) return err('nothing to change -- pass at least one field')
        const r = await rpc('schedule_update_request', { id: p.id, patch })
        if (failed(r)) return r
        if (!r.schedule) return err('update returned no schedule')
        return text(`Updated.\n\n${renderSchedule(r.schedule)}`)
      },
    },

    schedule_delete: {
      description: SCHEDULE_TOOL_SCHEMAS.delete.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.delete.inputSchema,
      async handle(p) {
        const r = await rpc('schedule_delete_request', { id: p.id })
        if (failed(r)) return r
        return text(`Deleted schedule ${r.deleted ?? p.id} and its run history.`)
      },
    },

    schedule_run_now: {
      description: SCHEDULE_TOOL_SCHEMAS.run_now.description,
      inputSchema: SCHEDULE_TOOL_SCHEMAS.run_now.inputSchema,
      async handle(p) {
        const r = await rpc('schedule_run_now_request', { id: p.id })
        if (failed(r)) return r
        return text(`Fired ${p.id} off-schedule.\n${renderRuns(r.runs ?? [])}`)
      },
    },
  }
}
