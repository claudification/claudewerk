/**
 * FIRING a `board-sweep` schedule -- the half of the path that is not the sweep.
 *
 * What these pin down is that a second action rides the EXISTING fire rules
 * rather than a parallel set of its own: the owner is still re-checked, the seat
 * ceiling still binds, a failure still counts toward the backoff that disarms a
 * schedule nobody is fixing -- and the run row says `swept`, because nothing was
 * spawned and a row claiming otherwise is the lie this epic is built against.
 */

import { describe, expect, test } from 'bun:test'
import type { ScheduledRun } from '../../shared/scheduled-run'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { type DispatchOutcome, type FireDeps, fireSchedule } from './fire'

const PROJECT = 'claude:///p'
const FIRED_AT = Date.parse('2026-08-22T04:00:00Z')

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'morning report',
    enabled: true,
    projectUri: PROJECT,
    cwd: '/p',
    cron: '0 6 * * *',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'skip',
    action: 'board-sweep',
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
  sweeps: string[]
}

function harness(
  opts: {
    enabled?: boolean | (() => boolean)
    sweep?: DispatchOutcome
    /** The runner throws instead of returning a failure. */
    runnerThrows?: boolean
    noRunner?: boolean
    maySpawn?: boolean
    inFlight?: number
  } = {},
): Harness {
  const runs: ScheduledRun[] = []
  const persisted: ScheduledTask[] = []
  const spawns: SpawnRequest[] = []
  const sweeps: string[] = []

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
    morningReportEnabled: () => (typeof opts.enabled === 'function' ? opts.enabled() : (opts.enabled ?? true)),
    now: () => FIRED_AT,
    ...(opts.noRunner
      ? {}
      : {
          runBoardSweep: async (task: ScheduledTask) => {
            sweeps.push(task.id)
            if (opts.runnerThrows) throw new Error('boom')
            return opts.sweep ?? { ok: true }
          },
        }),
  }
  return { deps, runs, persisted, spawns, sweeps }
}

function fire(task: ScheduledTask, h: Harness) {
  return fireSchedule(task, h.deps, { trigger: 'cron', minuteKey: '2026-08-22T06:00#Europe/Berlin' })
}

describe('a swept run is not a spawned run', () => {
  test('a successful sweep records `swept` and no conversation', async () => {
    const h = harness()
    const task = makeTask()
    const result = await fire(task, h)

    expect(result.outcome).toBe('swept')
    expect(result.conversationId).toBeUndefined()
    expect(h.runs[0]).toMatchObject({ outcome: 'swept', scheduleId: task.id })
    // No spawn was even built: the plan branches before `buildSpawnRequest`.
    expect(h.spawns).toEqual([])
    expect(h.sweeps).toEqual([task.id])
  })

  test('a spawn schedule in the same code path still records `spawned`', async () => {
    const h = harness()
    const result = await fire(makeTask({ action: 'spawn', prompt: 'do the thing' }), h)

    expect(result.outcome).toBe('spawned')
    expect(h.spawns).toHaveLength(1)
    expect(h.sweeps).toEqual([])
  })

  test('a schedule written before `action` existed is still a spawn', async () => {
    const h = harness()
    const { action: _dropped, ...legacy } = makeTask({ prompt: 'legacy prompt' })
    const result = await fire(legacy as ScheduledTask, h)
    expect(result.outcome).toBe('spawned')
  })
})

describe('the opt-in gate', () => {
  test('a project that never opted in is refused, and the refusal is not a failure', async () => {
    const h = harness({ enabled: false })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('skipped_disabled')
    expect(result.error).toContain(PROJECT)
    expect(h.sweeps).toEqual([])
    // NOT `error`: five quiet mornings on an opted-out project must not disarm
    // the schedule, so nothing is persisted and no failure is counted.
    expect(h.persisted).toEqual([])
  })

  test('the gate is checked at EVERY fire, so opting out later stops the sweep', async () => {
    const state = { enabled: true }
    const h = harness({ enabled: () => state.enabled })
    const task = makeTask()

    expect((await fire(task, h)).outcome).toBe('swept')
    state.enabled = false
    expect((await fire(task, h)).outcome).toBe('skipped_disabled')
  })

  test('the gate does not touch spawn schedules', async () => {
    const h = harness({ enabled: false })
    expect((await fire(makeTask({ action: 'spawn', prompt: 'p' }), h)).outcome).toBe('spawned')
  })
})

describe('a sweep obeys every rule a spawn obeys', () => {
  test('an owner who lost `spawn` disarms the schedule before the sweep runs', async () => {
    const h = harness({ maySpawn: false })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('error')
    expect(h.sweeps).toEqual([])
    expect(h.persisted[0].enabled).toBe(false)
  })

  test('the scheduler ceiling refuses it like anything else', async () => {
    const h = harness({ inFlight: 3 })
    const result = await fire(makeTask(), h)

    expect(result.outcome).toBe('skipped_overlap')
    expect(result.error).toContain('ceiling')
    expect(h.sweeps).toEqual([])
  })

  test('a failing sweep counts toward the backoff that eventually disarms it', async () => {
    const h = harness({ sweep: { ok: false, error: 'sentinel timed out (10s)' } })
    const result = await fire(makeTask({ consecutiveFailures: 4 }), h)

    expect(result).toMatchObject({ outcome: 'error', error: 'sentinel timed out (10s)' })
    expect(h.persisted[0]).toMatchObject({ consecutiveFailures: 5, enabled: false })
  })

  test('a throwing runner is a failed fire, not a crashed tick', async () => {
    const h = harness({ runnerThrows: true })
    expect(await fire(makeTask(), h)).toMatchObject({ outcome: 'error', error: 'boom' })
  })

  test('a board-sweep schedule on a broker with no runner fails loudly', async () => {
    const h = harness({ noRunner: true })
    const result = await fire(makeTask(), h)

    // The one thing it must NOT do is look like it ran.
    expect(result.outcome).toBe('error')
    expect(result.error).toContain('board-sweep runner')
    expect(h.runs[0].outcome).toBe('error')
  })
})
