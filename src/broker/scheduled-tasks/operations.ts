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
 * The `epic` block after a patch -- the ONE field that merges instead of
 * replacing, and the one that a change of `action` can clear.
 *
 * MERGES because a patch that raises a single ceiling must not have to re-send
 * the epic id beside it; the top-level spread would otherwise replace the whole
 * block with the one knob and the record would fail validation.
 *
 * CLEARS on a CHANGE away from `epic-start`, because that is the only way to
 * turn an epic schedule back into a spawn: an `epic` block left behind on
 * another action is refused by `checkAction`, and a patch has no spelling for
 * "remove this field".
 *
 * Clearing is deliberately narrow. It fires only when the action ACTUALLY
 * changes and the patch sends no block of its own; every other stray `epic`
 * reaches `checkAction` and is REFUSED there. Clearing them instead would
 * silently drop the one field whose loss is invisible -- `schedule_update
 * id=<a spawn> epic_id=e1 max_usd=200` would answer 200, change nothing, and
 * arm nothing, forever. A patch that both changes the action away AND sends an
 * epic block contradicts itself and is refused for the same reason.
 */
function mergedEpic(existing: ScheduledTask, patch: ScheduledTaskPatch): Pick<ScheduledTask, 'epic'> | undefined {
  const action = patch.action ?? existing.action
  if (action === 'epic-start') {
    if (!patch.epic) return undefined
    return { epic: { ...existing.epic, ...patch.epic } as ScheduledTask['epic'] }
  }
  if (existing.action === 'epic-start' && !patch.epic) return { epic: undefined }
  return undefined
}

/**
 * Apply a patch to an existing schedule.
 *
 * The WHOLE merged record is re-validated, not just the patch: a change that is
 * individually valid can still produce an impossible schedule (an `endAt` that
 * now precedes `startAt`, a cron AND a runAt).
 */
export function patchSchedule(store: StoreDriver, existing: ScheduledTask, patch: ScheduledTaskPatch): OpResult {
  const merged = { ...existing, ...patch, ...mergedEpic(existing, patch), updatedAt: Date.now() }
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
