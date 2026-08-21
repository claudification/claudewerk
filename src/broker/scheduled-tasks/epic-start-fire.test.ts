/**
 * FIRING an `epic-start` schedule -- the half of the path that is not the arm.
 *
 * `when=queue` and `when=<instant>` say when an ARMED epic run may dispatch;
 * neither can arm one, so until this action existed "start the migration epic at
 * 02:00 on Saturday" was a human pressing RUN. What these pin down is that the
 * third action rides the EXISTING fire rules rather than a parallel set of its
 * own -- the owner is still re-checked, the seat ceiling still binds, a failure
 * still counts toward the backoff -- and that the run row says `armed`, because
 * nothing was spawned and the engine's beat may not dispatch for hours.
 */

import { describe, expect, test } from 'bun:test'
import type { ScheduledRun } from '../../shared/scheduled-run'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { type DispatchOutcome, type FireDeps, fireSchedule } from './fire'

const PROJECT = 'claude:///p'
const FIRED_AT = Date.parse('2026-08-22T02:00:00Z')

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
    epic: { epicId: 'epic-migration', when: 'window' },
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    createdBy: 'jonas',
    createdAt: 0,
    updatedAt: 0,
    runCount: 0,
    consecutiveFailures: 0,
    ...over,
  }
}

interface Harness {
  deps: FireDeps
  runs: ScheduledRun[]
  persisted: ScheduledTask[]
  spawns: SpawnRequest[]
  arms: string[]
}

function harness(
  opts: {
    /** The refusal `epicsScannerRefusal` gives back, if any. */
    refusal?: string | null
    arm?: DispatchOutcome
    armThrows?: boolean
    noRunner?: boolean
    maySpawn?: boolean
    inFlight?: number
  } = {},
): Harness {
  const runs: ScheduledRun[] = []
  const persisted: ScheduledTask[] = []
  const spawns: SpawnRequest[] = []
  const arms: string[] = []

  const deps: FireDeps = {
    async dispatch(req) {
      spawns.push(req)
      return { ok: true, conversationId: 'conv_1', jobId: 'job_1' }
    },
    isConversationAlive: () => false,
    lastSpawnedConversationId: () => null,
    ownerMaySpawn: () => opts.maySpawn ?? true,
    persist: task => persisted.push(task),
    recordRun: run => runs.push(run),
    inFlight: () => opts.inFlight ?? 0,
    inFlightForOrder: () => 0,
    claimSlot: () => () => {},
    maxInFlight: 3,
    morningReportEnabled: () => true,
    epicsScannerRefusal: () => opts.refusal ?? null,
    now: () => FIRED_AT,
    ...(opts.noRunner
      ? {}
      : {
          startEpicRun: async (task: ScheduledTask) => {
            arms.push(task.epic?.epicId ?? '(none)')
            if (opts.armThrows) throw new Error('boom')
            return opts.arm ?? { ok: true }
          },
        }),
  }
  return { deps, runs, persisted, spawns, arms }
}

function fire(task: ScheduledTask, h: Harness) {
  return fireSchedule(task, h.deps, { trigger: 'cron', minuteKey: '2026-08-22T02:00#Europe/Berlin' })
}

describe('an armed run is not a spawned run', () => {
  test('a successful arm records `armed` and no conversation', async () => {
    const h = harness()
    const task = makeTask()
    const result = await fire(task, h)

    expect(result.outcome).toBe('armed')
    expect(result.conversationId).toBeUndefined()
    expect(h.runs[0]).toMatchObject({ outcome: 'armed', scheduleId: task.id })
    // No spawn was even built: the plan branches before `buildSpawnRequest`.
    expect(h.spawns).toEqual([])
    expect(h.arms).toEqual(['epic-migration'])
  })

  test('a spawn schedule in the same code path still records `spawned`', async () => {
    const h = harness()
    const result = await fire(makeTask({ action: 'spawn', epic: undefined, prompt: 'do the thing' }), h)

    expect(result.outcome).toBe('spawned')
    expect(h.spawns).toHaveLength(1)
    expect(h.arms).toEqual([])
  })
})

describe('the "epics" opt-in gate', () => {
  test('an opted-out project is a schedule declining to run, not a failure', async () => {
    const h = harness({ refusal: 'the "epics" scanner is off for claude:///p' })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('skipped_disabled')
    expect(result.error).toContain('"epics" scanner is off')
    expect(h.arms).toEqual([])
    // NOT `error`: five quiet Saturdays on an opted-out project must not disarm
    // the schedule, so nothing is persisted and no failure is counted.
    expect(h.persisted).toEqual([])
  })

  test('the gate does not touch board-sweep schedules -- they have their own box', async () => {
    const h = harness({ refusal: 'epics is off' })
    h.deps.runBoardSweep = async () => ({ ok: true })
    const result = await fire(makeTask({ action: 'board-sweep', epic: undefined }), h)
    expect(result.outcome).toBe('swept')
  })

  test('the gate does not touch spawn schedules', async () => {
    const h = harness({ refusal: 'epics is off' })
    const result = await fire(makeTask({ action: 'spawn', epic: undefined, prompt: 'p' }), h)
    expect(result.outcome).toBe('spawned')
  })
})

describe('an arm obeys every rule a spawn obeys', () => {
  test('an owner who lost `spawn` disarms the schedule before anything is armed', async () => {
    const h = harness({ maySpawn: false })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('error')
    expect(h.arms).toEqual([])
    expect(h.persisted[0].enabled).toBe(false)
  })

  test('the scheduler ceiling refuses it like anything else', async () => {
    const h = harness({ inFlight: 3 })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('skipped_overlap')
    expect(result.error).toContain('ceiling')
    expect(h.arms).toEqual([])
  })

  test('a failing arm counts toward the backoff that eventually disarms it', async () => {
    const h = harness({ arm: { ok: false, error: 'sentinel timed out (10s)' } })
    const result = await fire(makeTask({ consecutiveFailures: 4 }), h)

    expect(result).toMatchObject({ outcome: 'error', error: 'sentinel timed out (10s)' })
    expect(h.persisted[0]).toMatchObject({ consecutiveFailures: 5, enabled: false })
  })

  test('a throwing runner is a failed fire, not a crashed tick', async () => {
    const h = harness({ armThrows: true })
    expect(await fire(makeTask(), h)).toMatchObject({ outcome: 'error', error: 'boom' })
  })

  test('an epic-start schedule on a broker with no runner fails loudly', async () => {
    const h = harness({ noRunner: true })
    const result = await fire(makeTask(), h)

    // The one thing it must NOT do is look like it armed something.
    expect(result.outcome).toBe('error')
    expect(result.error).toContain('epic-start runner')
    expect(h.runs[0].outcome).toBe('error')
  })
})
