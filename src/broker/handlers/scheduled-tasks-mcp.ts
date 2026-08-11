/**
 * The AGENT-facing schedule surface: the wire half of the `schedule_*` MCP
 * tools. Six requests, one `schedule_result` reply shape.
 *
 * The trust gate and the reply envelope live in `scheduled-tasks-gate.ts`; the
 * write path itself is `scheduled-tasks/operations.ts`, shared with the HTTP
 * routes so the agent surface cannot grow a laxer validator than the panel's.
 *
 * Ownership is the other half of the gate: a conversation is not a permission
 * principal, so an agent-created schedule still runs as a real USER whose
 * grants are re-checked at every fire. `owner.ts` refuses a create that cannot
 * name one, rather than arming something that quietly disarms itself later.
 *
 * Dependencies are injected (`createScheduleHandlers`) for the same reason the
 * engine's are: the gate is worth testing without an auth store or a live
 * scheduler, and `mock.module` is process-global -- mocking these would break
 * every sibling suite in the same run.
 */

import { scheduledTaskCreateSchema, scheduledTaskPatchSchema } from '../../shared/scheduled-task'
import type { HandlerContext, MessageData } from '../handler-context'
import { AGENT_HOST_ONLY, registerHandlers } from '../message-router'
import { getScheduledTaskEngine } from '../scheduled-tasks/engine-registry'
import { createSchedule, patchSchedule } from '../scheduled-tasks/operations'
import { type OwnerResult, resolveScheduleOwner } from '../scheduled-tasks/owner'
import { announce, callerTag, fail, isBenevolent, readScope, respond, targetSchedule } from './scheduled-tasks-gate'

export interface ScheduleHandlerDeps {
  resolveOwner(explicit?: string): OwnerResult
  getEngine(): { runNow(id: string): Promise<{ ok: boolean; error?: string }> } | null
}

const REAL_DEPS: ScheduleHandlerDeps = {
  resolveOwner: explicit => resolveScheduleOwner(explicit),
  getEngine: () => getScheduledTaskEngine(),
}

export function createScheduleHandlers(deps: ScheduleHandlerDeps = REAL_DEPS) {
  /** Every write shares this preamble: trusted enough, and the target exists. */
  function write(verb: string, ctx: HandlerContext, data: MessageData) {
    if (!isBenevolent(ctx)) return { error: `${verb} a schedule requires benevolent trust level` }
    return targetSchedule(ctx, data)
  }

  function list(ctx: HandlerContext, data: MessageData): void {
    const scope = readScope(ctx, data)
    if ('error' in scope) {
      fail(ctx, data, scope.error)
      return
    }
    respond(ctx, data, {
      ok: true,
      schedules: ctx.store.scheduledTasks.list(scope.project ? { projectUri: scope.project } : undefined),
    })
  }

  function get(ctx: HandlerContext, data: MessageData): void {
    const scope = readScope(ctx, data)
    if ('error' in scope) {
      fail(ctx, data, scope.error)
      return
    }
    const found = targetSchedule(ctx, data)
    if ('error' in found) {
      fail(ctx, data, found.error)
      return
    }
    // A scoped reader may only see a schedule inside the project it may read.
    if (scope.project && found.task.projectUri !== scope.project) {
      fail(ctx, data, `schedule "${found.task.id}" belongs to another project`)
      return
    }
    const limit = typeof data.runLimit === 'number' ? data.runLimit : 10
    respond(ctx, data, {
      ok: true,
      schedule: found.task,
      runs: ctx.store.scheduledTasks.listRuns(found.task.id, limit),
    })
  }

  function create(ctx: HandlerContext, data: MessageData): void {
    if (!isBenevolent(ctx)) {
      fail(ctx, data, 'Creating a schedule requires benevolent trust level')
      return
    }

    const parsed = scheduledTaskCreateSchema.safeParse(data.schedule)
    if (!parsed.success) {
      fail(ctx, data, parsed.error.issues[0]?.message ?? 'invalid schedule')
      return
    }

    const owner = deps.resolveOwner(typeof data.owner === 'string' ? data.owner : undefined)
    if (!owner.ok) {
      fail(ctx, data, owner.error)
      return
    }

    const created = createSchedule(ctx.store, parsed.data, owner.userName)
    if (!created.ok) {
      fail(ctx, data, created.error)
      return
    }

    ctx.log.info(
      `[sched] created id=${created.task.id} name="${created.task.name}" project=${created.task.projectUri} ` +
        `cron="${created.task.cron}" runAt=${created.task.runAt} tz=${created.task.tz} enabled=${created.task.enabled} ` +
        `by=agent conv=${callerTag(ctx)} owner=${owner.userName}`,
    )
    announce(ctx)
    respond(ctx, data, { ok: true, schedule: created.task })
  }

  function update(ctx: HandlerContext, data: MessageData): void {
    const found = write('Changing', ctx, data)
    if ('error' in found) {
      fail(ctx, data, found.error)
      return
    }

    const parsed = scheduledTaskPatchSchema.safeParse(data.patch)
    if (!parsed.success) {
      fail(ctx, data, parsed.error.issues[0]?.message ?? 'invalid patch')
      return
    }

    const patched = patchSchedule(ctx.store, found.task, parsed.data)
    if (!patched.ok) {
      fail(ctx, data, patched.error)
      return
    }

    ctx.log.info(
      `[sched] patched id=${patched.task.id} name="${patched.task.name}" ` +
        `enabled=${found.task.enabled}->${patched.task.enabled} cron="${found.task.cron}"->"${patched.task.cron}" ` +
        `by=agent conv=${callerTag(ctx)}`,
    )
    announce(ctx)
    respond(ctx, data, { ok: true, schedule: patched.task })
  }

  function remove(ctx: HandlerContext, data: MessageData): void {
    const found = write('Deleting', ctx, data)
    if ('error' in found) {
      fail(ctx, data, found.error)
      return
    }

    ctx.store.scheduledTasks.delete(found.task.id)
    ctx.log.info(`[sched] deleted id=${found.task.id} name="${found.task.name}" by=agent conv=${callerTag(ctx)}`)
    announce(ctx)
    respond(ctx, data, { ok: true, deleted: found.task.id })
  }

  async function runNow(ctx: HandlerContext, data: MessageData): Promise<void> {
    const found = write('Running', ctx, data)
    if ('error' in found) {
      fail(ctx, data, found.error)
      return
    }

    const engine = deps.getEngine()
    if (!engine) return fail(ctx, data, 'scheduler is not running')

    ctx.log.info(`[sched] run-now id=${found.task.id} by=agent conv=${callerTag(ctx)}`)
    const res = await engine.runNow(found.task.id)
    announce(ctx)
    if (!res.ok) return fail(ctx, data, res.error ?? 'run failed')
    respond(ctx, data, { ok: true, runs: ctx.store.scheduledTasks.listRuns(found.task.id, 1) })
  }

  return {
    schedule_list_request: list,
    schedule_get_request: get,
    schedule_create_request: create,
    schedule_update_request: update,
    schedule_delete_request: remove,
    schedule_run_now_request: (ctx: HandlerContext, data: MessageData) => {
      void runNow(ctx, data)
    },
  }
}

export function registerScheduledTaskMcpHandlers(): void {
  registerHandlers(createScheduleHandlers(), AGENT_HOST_ONLY)
}
