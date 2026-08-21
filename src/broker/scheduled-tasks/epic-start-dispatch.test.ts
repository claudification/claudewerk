/**
 * The broker half of an `epic-start` schedule: the payload translation and the
 * refusals. The arm itself is `epic-arm.test.ts`; nothing here re-tests it.
 *
 * The translation is the part worth pinning. `when` is the schedule's spelling
 * and `cadence` is the run file's, and an epic `start` MERGES -- so a key sent
 * as an explicit `undefined` is not a no-op, it is a weekly clobber of a knob a
 * human raised by hand.
 */

import { describe, expect, test } from 'bun:test'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import { dispatchEpicStart, toStartPayload } from './epic-start-dispatch'

const PROJECT = 'claude:///p'

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'arm the migration',
    enabled: true,
    projectUri: PROJECT,
    cwd: '/p',
    cron: '0 2 * * 6',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    action: 'epic-start',
    epic: { epicId: 'epic-migration' },
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

interface Armed {
  project: string
  epicId: string
  start: Record<string, unknown>
}

function harness(result: { ok: boolean; error?: string } = { ok: true }) {
  const arms: Armed[] = []
  return {
    arms,
    deps: {
      arm: async (project: string, epicId: string, start: Record<string, unknown>) => {
        arms.push({ project, epicId, start })
        return result
      },
    },
  }
}

describe('the payload the arm receives', () => {
  test("`when` becomes `cadence` -- the run file's spelling for the same axis", () => {
    expect(toStartPayload({ epicId: 'e1', when: 'window,queue' })).toEqual({ cadence: 'window,queue' })
  })

  test('every cap travels under the name the sentinel reads', () => {
    expect(
      toStartPayload({
        epicId: 'e1',
        target: 'merged',
        concurrency: 5,
        maxGens: 12,
        maxUsd: 40,
        maxWallClockMinutes: 120,
      }),
    ).toEqual({ target: 'merged', concurrency: 5, maxGens: 12, maxUsd: 40, maxWallClockMinutes: 120 })
  })

  test('a knob the schedule never set is OMITTED, not sent as undefined', () => {
    // `start` merges, so an explicit key is how a weekly schedule quietly
    // resets a ceiling somebody raised by hand on Tuesday.
    const payload = toStartPayload({ epicId: 'e1' })
    expect(payload).toEqual({})
    expect(Object.hasOwn(payload, 'maxUsd')).toBe(false)
  })

  test('a zero cap is a REAL value -- it disarms that handbrake, it is not "unset"', () => {
    expect(toStartPayload({ epicId: 'e1', maxUsd: 0 })).toEqual({ maxUsd: 0 })
  })

  test('the epic id and the project come off the schedule, never the payload', async () => {
    const h = harness()
    await dispatchEpicStart(makeTask({ epic: { epicId: 'epic-migration', when: 'now' } }), h.deps)
    expect(h.arms).toEqual([{ project: PROJECT, epicId: 'epic-migration', start: { cadence: 'now' } }])
  })
})

describe('refusals', () => {
  test('a failed arm is a failed dispatch, with the reason kept', async () => {
    const h = harness({ ok: false, error: 'the "epics" scanner is off' })
    expect(await dispatchEpicStart(makeTask(), h.deps)).toEqual({ ok: false, error: 'the "epics" scanner is off' })
  })

  test('a failed arm with no reason still says something rather than nothing', async () => {
    const h = harness({ ok: false })
    expect(await dispatchEpicStart(makeTask(), h.deps)).toMatchObject({ ok: false, error: 'arming the epic failed' })
  })

  test('a record with no epic block fails the fire instead of arming a blank', async () => {
    const h = harness()
    const result = await dispatchEpicStart(makeTask({ epic: undefined }), h.deps)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('names no epic')
    expect(h.arms).toEqual([])
  })
})
