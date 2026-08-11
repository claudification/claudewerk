/**
 * Engine + fire tests -- the tick, the guards, and the run history.
 *
 * Everything runs against the memory driver with an injected clock and a fake
 * dispatch, so a "did it fire, once, with the right request?" question is
 * answered in milliseconds and without a sentinel.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { createMemoryDriver } from '../store/memory/driver'
import type { StoreDriver } from '../store/types'
import { type EngineDeps, startScheduledTaskEngine } from './engine'
import { buildSpawnRequest, type DispatchOutcome } from './fire'

const BERLIN = 'Europe/Berlin'
/** 09:00 Berlin, a Wednesday. */
const DUE = Date.parse('2026-08-12T07:00:00Z')

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'nightly',
    enabled: true,
    projectUri: 'claude:///p',
    cwd: '/p',
    cron: '0 9 * * *',
    tz: BERLIN,
    catchUp: 'skip',
    overlap: 'skip',
    prompt: 'do the thing',
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
  store: StoreDriver
  requests: SpawnRequest[]
  alive: Set<string>
  notifications: string[]
  nowMs: number
  engine: ReturnType<typeof startScheduledTaskEngine>
}

function harness(opts: { dispatch?: (req: SpawnRequest) => DispatchOutcome; maySpawn?: boolean } = {}): Harness {
  const store = createMemoryDriver()
  store.init()
  const requests: SpawnRequest[] = []
  const alive = new Set<string>()
  const notifications: string[] = []
  const state = { nowMs: DUE }

  const deps: EngineDeps = {
    store,
    now: () => state.nowMs,
    async dispatch(req) {
      requests.push(req)
      return opts.dispatch
        ? opts.dispatch(req)
        : { ok: true, conversationId: `conv_${requests.length}`, jobId: 'job_1' }
    },
    isConversationAlive: id => alive.has(id),
    lastSpawnedConversationId(scheduleId) {
      for (const run of store.scheduledTasks.listRuns(scheduleId, 20)) {
        if (run.outcome === 'spawned' && run.conversationId) return run.conversationId
      }
      return null
    },
    ownerMaySpawn: () => opts.maySpawn ?? true,
    notify: message => notifications.push(message),
  }

  const engine = startScheduledTaskEngine(deps)
  return {
    store,
    requests,
    alive,
    notifications,
    get nowMs() {
      return state.nowMs
    },
    set nowMs(value: number) {
      state.nowMs = value
    },
    engine,
  }
}

describe('buildSpawnRequest', () => {
  test('the schedule owns target, prompt and identity -- a profile cannot override them', () => {
    const task = makeTask({ cwd: '/real', prompt: 'the real prompt' })
    const profile = {
      id: 'lp_x',
      name: 'p',
      spawn: { cwd: '/hijacked', prompt: 'hijacked', model: 'claude-haiku-4-5' },
      createdAt: 0,
      updatedAt: 0,
    } as never
    const req = buildSpawnRequest(task, profile, DUE)
    expect(req.cwd).toBe('/real')
    expect(req.prompt).toBe('the real prompt')
    // Non-conflicting profile fields still come through.
    expect(req.model).toBe('claude-haiku-4-5')
  })

  test('the schedule spawn overrides the profile', () => {
    const task = makeTask({ spawn: { model: 'claude-opus-5' } })
    const profile = { id: 'lp_x', name: 'p', spawn: { model: 'claude-haiku-4-5' }, createdAt: 0, updatedAt: 0 } as never
    expect(buildSpawnRequest(task, profile, DUE).model).toBe('claude-opus-5')
  })

  test('names the run with a timestamp and stays within the label cap', () => {
    const req = buildSpawnRequest(makeTask({ name: 'x'.repeat(100) }), null, DUE)
    expect(req.name?.length).toBeLessThanOrEqual(80)
  })

  test('carries the ad-hoc contract through', () => {
    const req = buildSpawnRequest(makeTask(), null, DUE)
    expect(req.adHoc).toBe(true)
    expect(req.leaveRunning).toBe(false)
  })
})

describe('engine tick', () => {
  let h: Harness

  beforeEach(() => {
    h = harness()
  })

  test('fires a due schedule exactly once and records it', async () => {
    const task = makeTask()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.prompt).toBe('do the thing')
    const runs = h.store.scheduledTasks.listRuns(task.id)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('spawned')
    expect(runs[0]?.trigger).toBe('cron')
  })

  test('a second tick in the same minute does NOT re-fire', async () => {
    h.store.scheduledTasks.upsert(makeTask())
    await h.engine.tick()
    await h.engine.tick()
    await h.engine.tick()
    expect(h.requests).toHaveLength(1)
  })

  test('fires again the next day', async () => {
    h.store.scheduledTasks.upsert(makeTask())
    await h.engine.tick()
    h.nowMs = DUE + 86_400_000
    await h.engine.tick()
    expect(h.requests).toHaveLength(2)
  })

  test('does not fire when the minute does not match', async () => {
    h.store.scheduledTasks.upsert(makeTask())
    h.nowMs = DUE + 60_000
    await h.engine.tick()
    expect(h.requests).toHaveLength(0)
  })

  test('skips a disabled schedule entirely', async () => {
    h.store.scheduledTasks.upsert(makeTask({ enabled: false }))
    await h.engine.tick()
    expect(h.requests).toHaveLength(0)
  })

  test('bumps runCount and clears the failure counter on success', async () => {
    const task = makeTask({ consecutiveFailures: 2 })
    h.store.scheduledTasks.upsert(task)
    await h.engine.tick()
    const after = h.store.scheduledTasks.get(task.id)
    expect(after?.runCount).toBe(1)
    expect(after?.consecutiveFailures).toBe(0)
    expect(after?.lastRunAt).toBe(DUE)
  })

  test('disarms an expired schedule so it stops being walked', async () => {
    const task = makeTask({ endAt: DUE - 1000 })
    h.store.scheduledTasks.upsert(task)
    await h.engine.tick()
    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
    expect(h.requests).toHaveLength(0)
  })

  test('disarms once maxRuns is reached', async () => {
    const task = makeTask({ maxRuns: 1, runCount: 1 })
    h.store.scheduledTasks.upsert(task)
    await h.engine.tick()
    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
  })

  test('an unparseable cron neither fires nor crashes the tick', async () => {
    h.store.scheduledTasks.upsert(makeTask({ cron: 'nonsense' }))
    h.store.scheduledTasks.upsert(makeTask({ name: 'healthy' }))
    await h.engine.tick()
    expect(h.requests).toHaveLength(1)
    expect(h.requests[0]?.name).toStartWith('healthy')
  })

  test('one schedule per project fires independently', async () => {
    h.store.scheduledTasks.upsert(makeTask({ projectUri: 'claude:///a', cwd: '/a' }))
    h.store.scheduledTasks.upsert(makeTask({ projectUri: 'claude:///b', cwd: '/b' }))
    await h.engine.tick()
    expect(h.requests.map(r => r.cwd).sort()).toEqual(['/a', '/b'])
  })
})

describe('overlap policy', () => {
  test('skip: does not fire while the previous run is still alive', async () => {
    const h = harness()
    const task = makeTask({ overlap: 'skip' })
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()
    h.alive.add('conv_1') // the spawned conversation is still running

    h.nowMs = DUE + 86_400_000
    await h.engine.tick()

    expect(h.requests).toHaveLength(1)
    const outcomes = h.store.scheduledTasks.listRuns(task.id).map(r => r.outcome)
    expect(outcomes).toContain('skipped_overlap')
  })

  test('skip: fires once the previous run has finished', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeTask({ overlap: 'skip' }))
    await h.engine.tick()
    // conv_1 never enters `alive`, i.e. it already ended.
    h.nowMs = DUE + 86_400_000
    await h.engine.tick()
    expect(h.requests).toHaveLength(2)
  })

  test('parallel: fires regardless of the previous run', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeTask({ overlap: 'parallel' }))
    await h.engine.tick()
    h.alive.add('conv_1')
    h.nowMs = DUE + 86_400_000
    await h.engine.tick()
    expect(h.requests).toHaveLength(2)
  })
})

describe('failure handling', () => {
  test('a failed dispatch records an error run and counts toward backoff', async () => {
    const h = harness({ dispatch: () => ({ ok: false, error: 'sentinel offline' }) })
    const task = makeTask()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    const runs = h.store.scheduledTasks.listRuns(task.id)
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.error).toBe('sentinel offline')
    const after = h.store.scheduledTasks.get(task.id)
    expect(after?.consecutiveFailures).toBe(1)
    expect(after?.runCount).toBe(0)
  })

  test('a throwing dispatch is a failed fire, not a crashed tick', async () => {
    const h = harness({
      dispatch: () => {
        throw new Error('boom')
      },
    })
    const task = makeTask()
    h.store.scheduledTasks.upsert(task)
    await h.engine.tick()
    expect(h.store.scheduledTasks.listRuns(task.id)[0]?.error).toContain('boom')
  })

  test('disarms itself and notifies after five consecutive failures', async () => {
    const h = harness({ dispatch: () => ({ ok: false, error: 'nope' }) })
    const task = makeTask({ cron: '* * * * *' })
    h.store.scheduledTasks.upsert(task)

    for (let i = 0; i < 5; i++) {
      h.nowMs = DUE + i * 60_000
      await h.engine.tick()
    }

    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
    expect(h.notifications.join(' ')).toContain('disabled after 5')
  })

  test('an owner who lost spawn permission disarms the schedule', async () => {
    const h = harness({ maySpawn: false })
    const task = makeTask()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    expect(h.requests).toHaveLength(0)
    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
    expect(h.store.scheduledTasks.listRuns(task.id)[0]?.error).toContain('no longer has spawn permission')
    expect(h.notifications.join(' ')).toContain('spawn permission')
  })
})

describe('runNow', () => {
  test('fires off-schedule and labels the run manual', async () => {
    const h = harness()
    const task = makeTask({ cron: '0 3 1 1 *' }) // basically never
    h.store.scheduledTasks.upsert(task)

    const res = await h.engine.runNow(task.id)

    expect(res.ok).toBe(true)
    expect(h.requests).toHaveLength(1)
    expect(h.store.scheduledTasks.listRuns(task.id)[0]?.trigger).toBe('manual')
  })

  test('does not consume the cron slot for the current minute', async () => {
    const h = harness()
    const task = makeTask()
    h.store.scheduledTasks.upsert(task)

    // Manual run during the very minute the cron is due...
    await h.engine.runNow(task.id)
    // ...and the scheduled fire still happens, exactly once.
    await h.engine.tick()
    await h.engine.tick()

    const triggers = h.store.scheduledTasks.listRuns(task.id).map(r => r.trigger)
    expect(triggers.filter(t => t === 'manual')).toHaveLength(1)
    expect(triggers.filter(t => t === 'cron')).toHaveLength(1)
  })

  test('reports a missing schedule rather than throwing', async () => {
    const h = harness()
    expect(await h.engine.runNow('sch_nope')).toEqual({ ok: false, error: 'schedule not found' })
  })

  test('runs even when disabled -- an explicit click beats the armed state', async () => {
    const h = harness()
    const task = makeTask({ enabled: false })
    h.store.scheduledTasks.upsert(task)
    expect((await h.engine.runNow(task.id)).ok).toBe(true)
    expect(h.requests).toHaveLength(1)
  })
})

describe('missed-fire reconciliation', () => {
  // Deliberately 90s past the hour: an hourly schedule is NOT due at this
  // instant, so anything that fires here came from reconciliation, not the
  // ordinary boot tick.
  const AFTER_THE_HOUR = DUE + 90_000

  test('records the gap without replaying it, by default', async () => {
    const store = createMemoryDriver()
    store.init()
    const task = makeTask({ cron: '0 * * * *', lastRunAt: Date.parse('2026-08-12T03:00:00Z') })
    store.scheduledTasks.upsert(task)

    const requests: SpawnRequest[] = []
    startScheduledTaskEngine({
      store,
      now: () => AFTER_THE_HOUR,
      async dispatch(req) {
        requests.push(req)
        return { ok: true, conversationId: 'conv_x' }
      },
      isConversationAlive: () => false,
      lastSpawnedConversationId: () => null,
      ownerMaySpawn: () => true,
    })
    await Bun.sleep(5) // boot reconcile is fire-and-forget

    const missed = store.scheduledTasks.listRuns(task.id, 50).filter(r => r.outcome === 'missed')
    expect(missed.length).toBeGreaterThan(0)
    expect(requests).toHaveLength(0)
  })

  test('catchUp "once" re-runs a single recent miss', async () => {
    const store = createMemoryDriver()
    store.init()
    const task = makeTask({
      cron: '0 * * * *',
      catchUp: 'once',
      lastRunAt: Date.parse('2026-08-12T05:00:00Z'),
    })
    store.scheduledTasks.upsert(task)

    const requests: SpawnRequest[] = []
    startScheduledTaskEngine({
      store,
      now: () => AFTER_THE_HOUR,
      async dispatch(req) {
        requests.push(req)
        return { ok: true, conversationId: 'conv_x' }
      },
      isConversationAlive: () => false,
      lastSpawnedConversationId: () => null,
      ownerMaySpawn: () => true,
    })
    await Bun.sleep(5)

    expect(requests).toHaveLength(1)
    const triggers = store.scheduledTasks.listRuns(task.id, 50).map(r => r.trigger)
    expect(triggers).toContain('catchup')
  })
})
