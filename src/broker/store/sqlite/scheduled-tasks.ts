/**
 * SQLite store for SCHEDULES and their RUN history.
 *
 * Two tables rather than a KV blob (where launch profiles live): the engine tick
 * reads "enabled schedules for every project" once a minute, the sidebar badge
 * asks "does THIS project have any", and run history is append-only rows that
 * need ordering and pruning. All three want an index, none of them want to
 * deserialize one giant JSON array.
 *
 * Shape follows `tasks.ts`: indexed columns for what we query on, the full record
 * as JSON in `data` so adding a schema field needs no migration.
 */

import type { Database } from 'bun:sqlite'
import type { ScheduledRun } from '../../../shared/scheduled-run'
import { type ScheduledTask, scheduledTaskSchema } from '../../../shared/scheduled-task'
import type { ScheduledTaskQuery, ScheduledTaskStore } from '../types'

type Row = Record<string, string | number | null>

/**
 * The JSON blob is the source of truth for the record; the columns exist to be
 * queried. Parsed through the schema so a row written by an older build cannot
 * hand the engine a half-shaped object.
 */
function rowToTask(row: Row): ScheduledTask | null {
  const parsed = scheduledTaskSchema.safeParse(JSON.parse(row.data as string))
  return parsed.success ? parsed.data : null
}

function rowToRun(row: Row): ScheduledRun {
  return {
    id: row.id as string,
    scheduleId: row.schedule_id as string,
    firedAt: row.fired_at as number,
    minuteKey: row.minute_key as string,
    trigger: row.trigger as ScheduledRun['trigger'],
    outcome: row.outcome as ScheduledRun['outcome'],
    conversationId: (row.conversation_id as string) ?? undefined,
    jobId: (row.job_id as string) ?? undefined,
    error: (row.error as string) ?? undefined,
    endedAt: row.ended_at == null ? undefined : (row.ended_at as number),
    endStatus: (row.end_status as string) ?? undefined,
  }
}

export function createSqliteScheduledTaskStore(db: Database): ScheduledTaskStore {
  const stmtUpsert = db.prepare(`
    INSERT INTO scheduled_tasks (
      id, project_uri, name, enabled, cron, run_at, tz, created_by, data,
      last_run_at, last_fired_minute_key, run_count, consecutive_failures,
      created_at, updated_at
    )
    VALUES (
      $id, $projectUri, $name, $enabled, $cron, $runAt, $tz, $createdBy, $data,
      $lastRunAt, $lastFiredMinuteKey, $runCount, $consecutiveFailures,
      $createdAt, $updatedAt
    )
    ON CONFLICT(id) DO UPDATE SET
      project_uri = $projectUri,
      name = $name,
      enabled = $enabled,
      cron = $cron,
      run_at = $runAt,
      tz = $tz,
      data = $data,
      last_run_at = $lastRunAt,
      last_fired_minute_key = $lastFiredMinuteKey,
      run_count = $runCount,
      consecutive_failures = $consecutiveFailures,
      updated_at = $updatedAt
  `)

  const stmtGet = db.prepare('SELECT * FROM scheduled_tasks WHERE id = $id')
  const stmtDelete = db.prepare('DELETE FROM scheduled_tasks WHERE id = $id')
  const stmtDeleteRuns = db.prepare('DELETE FROM scheduled_task_runs WHERE schedule_id = $scheduleId')

  const stmtAddRun = db.prepare(`
    INSERT INTO scheduled_task_runs (
      id, schedule_id, fired_at, minute_key, trigger, outcome,
      conversation_id, job_id, error, ended_at, end_status
    )
    VALUES (
      $id, $scheduleId, $firedAt, $minuteKey, $trigger, $outcome,
      $conversationId, $jobId, $error, $endedAt, $endStatus
    )
  `)

  const stmtGetRun = db.prepare('SELECT * FROM scheduled_task_runs WHERE id = $id')
  const stmtListRuns = db.prepare(
    'SELECT * FROM scheduled_task_runs WHERE schedule_id = $scheduleId ORDER BY fired_at DESC LIMIT $limit',
  )
  const stmtFinishRun = db.prepare(
    'UPDATE scheduled_task_runs SET ended_at = $endedAt, end_status = $endStatus WHERE id = $id',
  )

  return {
    upsert(task) {
      stmtUpsert.run({
        id: task.id,
        projectUri: task.projectUri,
        name: task.name,
        enabled: task.enabled ? 1 : 0,
        // A one-shot has no cron; the column is NOT NULL from the first deploy,
        // so it stores '' and `run_at` carries the real answer.
        cron: task.cron ?? '',
        runAt: task.runAt ?? null,
        tz: task.tz,
        createdBy: task.createdBy,
        data: JSON.stringify(task),
        lastRunAt: task.lastRunAt ?? null,
        lastFiredMinuteKey: task.lastFiredMinuteKey ?? null,
        runCount: task.runCount,
        consecutiveFailures: task.consecutiveFailures,
        createdAt: task.createdAt,
        updatedAt: task.updatedAt,
      })
    },

    get(id) {
      const row = stmtGet.get({ id }) as Row | null
      return row ? rowToTask(row) : null
    },

    list(query?: ScheduledTaskQuery) {
      // Built per call rather than prepared: two optional predicates is four
      // shapes, and the tick reads this once a minute -- not a hot path.
      const where: string[] = []
      const params: Record<string, string | number> = {}
      if (query?.projectUri) {
        where.push('project_uri = $projectUri')
        params.projectUri = query.projectUri
      }
      if (query?.enabledOnly) where.push('enabled = 1')
      const sql = `SELECT * FROM scheduled_tasks${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY created_at ASC`
      const rows = db.prepare(sql).all(params) as Row[]
      const out: ScheduledTask[] = []
      for (const row of rows) {
        const task = rowToTask(row)
        // A row that no longer parses is skipped, not thrown: one bad record
        // must not take down the whole tick.
        if (task) out.push(task)
        else console.warn(`[sched-store] skipping unparseable schedule id=${row.id}`)
      }
      return out
    },

    delete(id) {
      // History goes with the schedule -- orphan runs would show up in no UI.
      stmtDeleteRuns.run({ scheduleId: id })
      return stmtDelete.run({ id }).changes > 0
    },

    addRun(run) {
      stmtAddRun.run({
        id: run.id,
        scheduleId: run.scheduleId,
        firedAt: run.firedAt,
        minuteKey: run.minuteKey,
        trigger: run.trigger,
        outcome: run.outcome,
        conversationId: run.conversationId ?? null,
        jobId: run.jobId ?? null,
        error: run.error ?? null,
        endedAt: run.endedAt ?? null,
        endStatus: run.endStatus ?? null,
      })
    },

    listRuns(scheduleId, limit = 50) {
      const rows = stmtListRuns.all({ scheduleId, limit: Math.max(1, Math.floor(limit)) }) as Row[]
      return rows.map(rowToRun)
    },

    getRun(runId) {
      const row = stmtGetRun.get({ id: runId }) as Row | null
      return row ? rowToRun(row) : null
    },

    finishRun(runId, endedAt, endStatus) {
      return stmtFinishRun.run({ id: runId, endedAt, endStatus }).changes > 0
    },

    pruneRuns(keepPerSchedule, cutoffMs) {
      // Age first (cheap, indexed), then the per-schedule tail so a chatty
      // schedule cannot bury a quiet one's history.
      let removed = db.prepare('DELETE FROM scheduled_task_runs WHERE fired_at < $cutoffMs').run({ cutoffMs }).changes
      const ids = db.prepare('SELECT DISTINCT schedule_id AS id FROM scheduled_task_runs').all() as Row[]
      const trim = db.prepare(`
        DELETE FROM scheduled_task_runs
        WHERE schedule_id = $scheduleId
          AND id NOT IN (
            SELECT id FROM scheduled_task_runs
            WHERE schedule_id = $scheduleId
            ORDER BY fired_at DESC
            LIMIT $keep
          )
      `)
      for (const row of ids) {
        removed += trim.run({ scheduleId: row.id as string, keep: Math.max(1, Math.floor(keepPerSchedule)) }).changes
      }
      return removed
    },
  }
}
