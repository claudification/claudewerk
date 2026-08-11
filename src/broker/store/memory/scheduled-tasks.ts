/**
 * In-memory SCHEDULE + RUN store -- the test twin of `sqlite/scheduled-tasks.ts`.
 *
 * Lives in its own file rather than inside `driver.ts`: that module is already
 * 1200+ lines, and every store added to it makes the next one harder to find.
 * Same shape as the sqlite side so the shared store test suite runs against both
 * and any behavioural drift between them shows up as a failure.
 */

import type { ScheduledRun } from '../../../shared/scheduled-run'
import type { ScheduledTask } from '../../../shared/scheduled-task'
import type { ScheduledTaskQuery, ScheduledTaskStore } from '../types'

export function createMemoryScheduledTaskStore(): ScheduledTaskStore {
  const schedules = new Map<string, ScheduledTask>()
  const runs = new Map<string, ScheduledRun>()

  /** Newest first, matching the sqlite ORDER BY. */
  function runsFor(scheduleId: string): ScheduledRun[] {
    return [...runs.values()].filter(r => r.scheduleId === scheduleId).sort((a, b) => b.firedAt - a.firedAt)
  }

  return {
    upsert(task) {
      schedules.set(task.id, { ...task })
    },

    get(id) {
      const found = schedules.get(id)
      return found ? { ...found } : null
    },

    list(query?: ScheduledTaskQuery) {
      let out = [...schedules.values()]
      if (query?.projectUri) out = out.filter(s => s.projectUri === query.projectUri)
      if (query?.enabledOnly) out = out.filter(s => s.enabled)
      return out.sort((a, b) => a.createdAt - b.createdAt).map(s => ({ ...s }))
    },

    delete(id) {
      for (const [runId, run] of runs) {
        if (run.scheduleId === id) runs.delete(runId)
      }
      return schedules.delete(id)
    },

    addRun(run) {
      runs.set(run.id, { ...run })
    },

    listRuns(scheduleId, limit = 50) {
      return runsFor(scheduleId)
        .slice(0, Math.max(1, Math.floor(limit)))
        .map(r => ({ ...r }))
    },

    getRun(runId) {
      const found = runs.get(runId)
      return found ? { ...found } : null
    },

    finishRun(runId, endedAt, endStatus) {
      const run = runs.get(runId)
      if (!run) return false
      runs.set(runId, { ...run, endedAt, endStatus })
      return true
    },

    pruneRuns(keepPerSchedule, cutoffMs) {
      let removed = 0
      for (const [runId, run] of runs) {
        if (run.firedAt >= cutoffMs) continue
        runs.delete(runId)
        removed++
      }
      const keep = Math.max(1, Math.floor(keepPerSchedule))
      for (const scheduleId of new Set([...runs.values()].map(r => r.scheduleId))) {
        for (const run of runsFor(scheduleId).slice(keep)) {
          runs.delete(run.id)
          removed++
        }
      }
      return removed
    },
  }
}
