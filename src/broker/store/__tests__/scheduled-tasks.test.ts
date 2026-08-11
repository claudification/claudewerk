/**
 * SCHEDULE + RUN store tests, run against BOTH drivers from one suite.
 *
 * The memory driver is what every engine/route test builds on, so any place it
 * diverges from sqlite is a bug that only shows up in production. Running the
 * identical assertions against both is the cheapest way to keep them honest.
 */

import { beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  newScheduledRunId,
  newScheduledTaskId,
  type ScheduledRun,
  type ScheduledTask,
} from '../../../shared/scheduled-task'
import { createMemoryDriver } from '../memory/driver'
import { createSqliteDriver } from '../sqlite/driver'
import type { StoreDriver } from '../types'

const T0 = Date.parse('2026-08-12T07:00:00Z')

function makeSchedule(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'nightly audit',
    enabled: true,
    projectUri: 'claude:///Users/jonas/projects/remote-claude',
    cwd: '/Users/jonas/projects/remote-claude',
    cron: '0 9 * * 1-5',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'Audit the repo and report.',
    spawn: { adHoc: true, leaveRunning: false, headless: true },
    createdBy: 'jonas',
    createdAt: T0,
    updatedAt: T0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

function makeRun(scheduleId: string, over: Partial<ScheduledRun> = {}): ScheduledRun {
  return {
    id: newScheduledRunId(),
    scheduleId,
    firedAt: T0,
    minuteKey: '2026-08-12T09:00@Europe/Berlin',
    trigger: 'cron',
    outcome: 'spawned',
    ...over,
  }
}

const DRIVERS: Array<[string, () => StoreDriver]> = [
  ['memory', () => createMemoryDriver()],
  ['sqlite', () => createSqliteDriver({ type: 'sqlite', dataDir: mkdtempSync(join(tmpdir(), 'sched-store-')) })],
]

for (const [driverName, makeDriver] of DRIVERS) {
  describe(`scheduledTasks store (${driverName})`, () => {
    let store: StoreDriver

    beforeEach(() => {
      store = makeDriver()
      store.init()
    })

    describe('schedules', () => {
      it('round-trips a full record', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        expect(store.scheduledTasks.get(schedule.id)).toEqual(schedule)
      })

      it('preserves the spawn snapshot verbatim', () => {
        const schedule = makeSchedule({
          spawn: {
            adHoc: true,
            leaveRunning: false,
            model: 'claude-haiku-4-5',
            effort: 'low',
            env: { FOO: 'bar' },
            transportMeta: { mode: 'new' },
          },
        })
        store.scheduledTasks.upsert(schedule)
        expect(store.scheduledTasks.get(schedule.id)?.spawn).toEqual(schedule.spawn)
      })

      it('returns null for an unknown id', () => {
        expect(store.scheduledTasks.get('sch_nope')).toBeNull()
      })

      it('upsert overwrites in place, it does not duplicate', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        store.scheduledTasks.upsert({ ...schedule, name: 'renamed', enabled: false, updatedAt: T0 + 1000 })
        expect(store.scheduledTasks.list()).toHaveLength(1)
        const got = store.scheduledTasks.get(schedule.id)
        expect(got?.name).toBe('renamed')
        expect(got?.enabled).toBe(false)
      })

      it('filters by project', () => {
        store.scheduledTasks.upsert(makeSchedule({ projectUri: 'claude:///a' }))
        store.scheduledTasks.upsert(makeSchedule({ projectUri: 'claude:///b' }))
        expect(store.scheduledTasks.list({ projectUri: 'claude:///a' })).toHaveLength(1)
        expect(store.scheduledTasks.list()).toHaveLength(2)
      })

      it('filters to enabled only -- what the engine tick reads', () => {
        store.scheduledTasks.upsert(makeSchedule({ enabled: true }))
        store.scheduledTasks.upsert(makeSchedule({ enabled: false }))
        expect(store.scheduledTasks.list({ enabledOnly: true })).toHaveLength(1)
      })

      it('combines both filters', () => {
        store.scheduledTasks.upsert(makeSchedule({ projectUri: 'claude:///a', enabled: true }))
        store.scheduledTasks.upsert(makeSchedule({ projectUri: 'claude:///a', enabled: false }))
        store.scheduledTasks.upsert(makeSchedule({ projectUri: 'claude:///b', enabled: true }))
        expect(store.scheduledTasks.list({ projectUri: 'claude:///a', enabledOnly: true })).toHaveLength(1)
      })

      it('lists in creation order', () => {
        const first = makeSchedule({ name: 'first', createdAt: T0 })
        const second = makeSchedule({ name: 'second', createdAt: T0 + 5000 })
        store.scheduledTasks.upsert(second)
        store.scheduledTasks.upsert(first)
        expect(store.scheduledTasks.list().map(s => s.name)).toEqual(['first', 'second'])
      })

      it('persists the fire bookkeeping the engine depends on', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        store.scheduledTasks.upsert({
          ...schedule,
          lastRunAt: T0 + 60_000,
          lastFiredMinuteKey: '2026-08-12T09:01@Europe/Berlin',
          runCount: 3,
          consecutiveFailures: 2,
        })
        const got = store.scheduledTasks.get(schedule.id)
        expect(got?.lastFiredMinuteKey).toBe('2026-08-12T09:01@Europe/Berlin')
        expect(got?.runCount).toBe(3)
        expect(got?.consecutiveFailures).toBe(2)
      })

      it('delete removes the schedule and reports whether it existed', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        expect(store.scheduledTasks.delete(schedule.id)).toBe(true)
        expect(store.scheduledTasks.get(schedule.id)).toBeNull()
        expect(store.scheduledTasks.delete(schedule.id)).toBe(false)
      })
    })

    describe('runs', () => {
      it('appends and reads back newest first', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 }))
        store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 + 60_000 }))
        const runs = store.scheduledTasks.listRuns(schedule.id)
        expect(runs.map(r => r.firedAt)).toEqual([T0 + 60_000, T0])
      })

      it('round-trips every optional field', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        const run = makeRun(schedule.id, {
          outcome: 'error',
          conversationId: 'conv_abc',
          jobId: 'job_def',
          error: 'sentinel offline',
        })
        store.scheduledTasks.addRun(run)
        expect(store.scheduledTasks.getRun(run.id)).toEqual(run)
      })

      it('honours the limit', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        for (let i = 0; i < 10; i++) {
          store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 + i * 60_000 }))
        }
        expect(store.scheduledTasks.listRuns(schedule.id, 3)).toHaveLength(3)
      })

      it('scopes runs to their schedule', () => {
        const a = makeSchedule()
        const b = makeSchedule()
        store.scheduledTasks.upsert(a)
        store.scheduledTasks.upsert(b)
        store.scheduledTasks.addRun(makeRun(a.id))
        expect(store.scheduledTasks.listRuns(a.id)).toHaveLength(1)
        expect(store.scheduledTasks.listRuns(b.id)).toHaveLength(0)
      })

      it('finishRun backfills the end state', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        const run = makeRun(schedule.id)
        store.scheduledTasks.addRun(run)
        expect(store.scheduledTasks.finishRun(run.id, T0 + 120_000, 'done')).toBe(true)
        const got = store.scheduledTasks.getRun(run.id)
        expect(got?.endedAt).toBe(T0 + 120_000)
        expect(got?.endStatus).toBe('done')
      })

      it('finishRun on an unknown run reports false rather than throwing', () => {
        expect(store.scheduledTasks.finishRun('schrun_nope', T0, 'done')).toBe(false)
      })

      it('deleting a schedule takes its history with it', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        store.scheduledTasks.addRun(makeRun(schedule.id))
        store.scheduledTasks.delete(schedule.id)
        expect(store.scheduledTasks.listRuns(schedule.id)).toHaveLength(0)
      })
    })

    describe('pruneRuns', () => {
      it('drops runs older than the cutoff', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 - 100_000 }))
        store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 }))
        expect(store.scheduledTasks.pruneRuns(100, T0 - 50_000)).toBe(1)
        expect(store.scheduledTasks.listRuns(schedule.id)).toHaveLength(1)
      })

      it('trims the per-schedule tail, keeping the newest', () => {
        const schedule = makeSchedule()
        store.scheduledTasks.upsert(schedule)
        for (let i = 0; i < 10; i++) {
          store.scheduledTasks.addRun(makeRun(schedule.id, { firedAt: T0 + i * 60_000 }))
        }
        store.scheduledTasks.pruneRuns(4, 0)
        const kept = store.scheduledTasks.listRuns(schedule.id, 100)
        expect(kept).toHaveLength(4)
        expect(kept[0]?.firedAt).toBe(T0 + 9 * 60_000)
      })

      it('a chatty schedule cannot bury a quiet one', () => {
        const chatty = makeSchedule()
        const quiet = makeSchedule()
        store.scheduledTasks.upsert(chatty)
        store.scheduledTasks.upsert(quiet)
        for (let i = 0; i < 20; i++) {
          store.scheduledTasks.addRun(makeRun(chatty.id, { firedAt: T0 + i * 60_000 }))
        }
        store.scheduledTasks.addRun(makeRun(quiet.id, { firedAt: T0 }))
        store.scheduledTasks.pruneRuns(5, 0)
        expect(store.scheduledTasks.listRuns(chatty.id, 100)).toHaveLength(5)
        expect(store.scheduledTasks.listRuns(quiet.id, 100)).toHaveLength(1)
      })
    })
  })
}
