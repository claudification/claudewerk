/**
 * HTTP routes for SCHEDULED TASKS.
 *
 *   GET    /api/scheduled-tasks           list (optionally ?project=)
 *   POST   /api/scheduled-tasks           create
 *   PATCH  /api/scheduled-tasks/:id       edit / enable / disable
 *   DELETE /api/scheduled-tasks/:id       remove (history goes with it)
 *   POST   /api/scheduled-tasks/:id/run   fire now, off-schedule
 *   GET    /api/scheduled-tasks/:id/runs  history, newest first
 *
 * Every route is gated on the `spawn` permission, because a schedule IS a spawn --
 * one that fires later, unattended, without anybody at the keyboard. Granting the
 * ability to create one is granting the ability to spawn.
 */

import { type Context, Hono } from 'hono'
import type { z } from 'zod'
import {
  newScheduledTaskId,
  SCHEDULE_MAX_COUNT,
  type ScheduledTask,
  scheduledTaskCreateSchema,
  scheduledTaskPatchSchema,
  validatedScheduledTaskSchema,
} from '../../shared/scheduled-task'
import { getAuthenticatedUser } from '../auth-routes'
import type { ConversationStore } from '../conversation-store'
import type { RouteHelpers } from '../routes/shared'
import type { StoreDriver } from '../store/types'
import { broadcastScheduledTasks } from './broadcast'
import type { ScheduledTaskEngine } from './engine'

export interface ScheduledTaskRouterDeps {
  store: StoreDriver
  conversationStore: ConversationStore
  helpers: RouteHelpers
  /** Supplied once the engine is running; "Run now" needs it. */
  getEngine(): ScheduledTaskEngine | null
}

export function createScheduledTasksRouter(deps: ScheduledTaskRouterDeps): Hono {
  const { store, conversationStore, helpers } = deps
  const app = new Hono()

  /** Shared gate: authenticated AND holding `spawn`. */
  function authorize(req: Request): { userName: string } | { status: 401 | 403; error: string } {
    const userName = getAuthenticatedUser(req)
    if (!userName) return { status: 401, error: 'Not authenticated' }
    if (!helpers.httpHasPermission(req, 'spawn', '*')) {
      return { status: 403, error: 'Forbidden: spawn permission required' }
    }
    return { userName }
  }

  interface Resolved {
    userName: string
    task: ScheduledTask
  }

  /**
   * Wrap a `/:id` handler with the preamble all of them need: authenticated,
   * permitted, and the schedule actually exists. A wrapper rather than three
   * copies of the same four lines -- that shape is how one route ends up
   * quietly missing a permission check.
   */
  function withSchedule(handler: (c: Context, found: Resolved) => Response | Promise<Response>) {
    return async (c: Context): Promise<Response> => {
      const auth = authorize(c.req.raw)
      if ('status' in auth) return c.json({ error: auth.error }, auth.status)
      const task = store.scheduledTasks.get(c.req.param('id') ?? '')
      if (!task) return c.json({ error: 'Schedule not found' }, 404)
      return handler(c, { userName: auth.userName, task })
    }
  }

  /**
   * Read + validate a JSON body against a schema. Both write routes need the
   * same three failure shapes (unparseable JSON, schema miss, and the useful
   * FIRST issue message), and stating them once keeps the two in step.
   */
  async function readBody<T>(
    c: Context,
    schema: { safeParse: (v: unknown) => { success: boolean; data?: T; error?: z.ZodError } },
  ): Promise<{ data: T } | { error: string; issues?: unknown }> {
    let raw: unknown
    try {
      raw = await c.req.json()
    } catch {
      return { error: 'Invalid JSON' }
    }
    const parsed = schema.safeParse(raw)
    if (!parsed.success || parsed.data === undefined) {
      return { error: parsed.error?.issues[0]?.message ?? 'invalid payload', issues: parsed.error?.issues }
    }
    return { data: parsed.data }
  }

  function announce(): void {
    broadcastScheduledTasks(conversationStore.getSubscribers(), store.scheduledTasks.list())
  }

  app.get('/api/scheduled-tasks', c => {
    const auth = authorize(c.req.raw)
    if ('status' in auth) return c.json({ error: auth.error }, auth.status)
    const project = c.req.query('project')
    return c.json({ scheduledTasks: store.scheduledTasks.list(project ? { projectUri: project } : undefined) })
  })

  app.post('/api/scheduled-tasks', async c => {
    const auth = authorize(c.req.raw)
    if ('status' in auth) return c.json({ error: auth.error }, auth.status)

    const body = await readBody(c, scheduledTaskCreateSchema)
    if ('error' in body) return c.json({ error: body.error, issues: body.issues }, 400)

    if (store.scheduledTasks.list().length >= SCHEDULE_MAX_COUNT) {
      return c.json({ error: `at most ${SCHEDULE_MAX_COUNT} schedules` }, 400)
    }

    const now = Date.now()
    const task: ScheduledTask = {
      ...body.data,
      id: newScheduledTaskId(),
      // The creator is the permission principal, re-checked at every fire.
      createdBy: auth.userName,
      createdAt: now,
      updatedAt: now,
      runCount: 0,
      consecutiveFailures: 0,
    }

    store.scheduledTasks.upsert(task)
    console.log(
      `[sched] created id=${task.id} name="${task.name}" project=${task.projectUri} ` +
        `cron="${task.cron}" tz=${task.tz} by=${auth.userName} enabled=${task.enabled}`,
    )
    announce()
    return c.json({ ok: true, scheduledTask: task })
  })

  app.patch(
    '/api/scheduled-tasks/:id',
    withSchedule(async (c, { task: existing, userName }) => {
      const body = await readBody(c, scheduledTaskPatchSchema)
      if ('error' in body) return c.json({ error: body.error, issues: body.issues }, 400)

      const merged = { ...existing, ...body.data, updatedAt: Date.now() }
      // Re-validate the WHOLE record: a patch that is individually valid can still
      // produce an impossible schedule (e.g. an endAt now before startAt).
      const validated = validatedScheduledTaskSchema.safeParse(merged)
      if (!validated.success) {
        return c.json({ error: validated.error.issues[0]?.message ?? 'invalid schedule' }, 400)
      }

      // Re-arming a schedule clears the failure count -- the user has presumably
      // fixed whatever was breaking it, and a stale count would disarm it early.
      const next =
        !existing.enabled && validated.data.enabled ? { ...validated.data, consecutiveFailures: 0 } : validated.data

      store.scheduledTasks.upsert(next)
      console.log(
        `[sched] patched id=${next.id} name="${next.name}" enabled=${existing.enabled}->${next.enabled} ` +
          `cron="${existing.cron}"->"${next.cron}" tz=${existing.tz}->${next.tz} by=${userName}`,
      )
      announce()
      return c.json({ ok: true, scheduledTask: next })
    }),
  )

  app.delete(
    '/api/scheduled-tasks/:id',
    withSchedule((c, { task, userName }) => {
      store.scheduledTasks.delete(task.id)
      console.log(`[sched] deleted id=${task.id} name="${task.name}" by=${userName}`)
      announce()
      return c.json({ ok: true })
    }),
  )

  app.post(
    '/api/scheduled-tasks/:id/run',
    withSchedule(async (c, { task, userName }) => {
      const engine = deps.getEngine()
      if (!engine) return c.json({ error: 'Scheduler is not running' }, 503)

      console.log(`[sched] run-now id=${task.id} by=${userName}`)
      const res = await engine.runNow(task.id)
      announce()
      if (!res.ok) return c.json({ error: res.error ?? 'run failed' }, 409)
      return c.json({ ok: true, runs: store.scheduledTasks.listRuns(task.id, 1) })
    }),
  )

  app.get(
    '/api/scheduled-tasks/:id/runs',
    withSchedule((c, { task }) => {
      const limit = Number(c.req.query('limit') ?? 50)
      return c.json({ runs: store.scheduledTasks.listRuns(task.id, Number.isFinite(limit) ? limit : 50) })
    }),
  )

  return app
}
