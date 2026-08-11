/**
 * The schedule write path, once.
 *
 * Two callers reach it: the HTTP routes (a human in the control panel) and the
 * MCP wire handlers (an agent). They authenticate and authorise ENTIRELY
 * differently -- cookie session + `spawn` permission vs. conversation trust
 * level -- but once a caller is past its own gate, what it may do to a schedule
 * must be identical. Keeping create/patch here is what stops the agent surface
 * from quietly growing a laxer validator than the panel's.
 *
 * Authorisation is deliberately NOT in this file. Each caller gates itself
 * first and passes in an already-resolved `createdBy`; nothing here decides who
 * is allowed to do anything.
 */

import {
  newScheduledTaskId,
  SCHEDULE_MAX_COUNT,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduledTaskPatch,
  validatedScheduledTaskSchema,
} from '../../shared/scheduled-task'
import type { StoreDriver } from '../store/types'

export type OpResult = { ok: true; task: ScheduledTask } | { ok: false; error: string }

/**
 * Persist a new schedule owned by `createdBy`.
 *
 * The caller is trusted to have resolved `createdBy` to a real principal --
 * `ownerMaySpawn` re-checks that user's grants at EVERY fire, so a name that
 * does not resolve produces a schedule that disarms itself after five silent
 * failures instead of running.
 */
export function createSchedule(store: StoreDriver, body: ScheduledTaskCreate, createdBy: string): OpResult {
  if (store.scheduledTasks.list().length >= SCHEDULE_MAX_COUNT) {
    return { ok: false, error: `at most ${SCHEDULE_MAX_COUNT} schedules` }
  }
  const now = Date.now()
  const task: ScheduledTask = {
    ...body,
    id: newScheduledTaskId(),
    createdBy,
    createdAt: now,
    updatedAt: now,
    runCount: 0,
    consecutiveFailures: 0,
  }
  store.scheduledTasks.upsert(task)
  return { ok: true, task }
}

/**
 * Apply a patch to an existing schedule.
 *
 * The WHOLE merged record is re-validated, not just the patch: a change that is
 * individually valid can still produce an impossible schedule (an `endAt` that
 * now precedes `startAt`, a cron AND a runAt).
 */
export function patchSchedule(store: StoreDriver, existing: ScheduledTask, patch: ScheduledTaskPatch): OpResult {
  const merged = { ...existing, ...patch, updatedAt: Date.now() }
  const validated = validatedScheduledTaskSchema.safeParse(merged)
  if (!validated.success) {
    return { ok: false, error: validated.error.issues[0]?.message ?? 'invalid schedule' }
  }
  // Re-arming clears the failure count -- whatever was breaking it has
  // presumably been fixed, and a stale count would disarm it early.
  const next =
    !existing.enabled && validated.data.enabled ? { ...validated.data, consecutiveFailures: 0 } : validated.data
  store.scheduledTasks.upsert(next)
  return { ok: true, task: next }
}
