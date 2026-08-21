/**
 * THE RESERVATION -- proved twice, at two altitudes.
 *
 * First as a table over the pure decision, because the interesting case is four
 * refiners due in the same minute and that is arithmetic, not a race. Then
 * end-to-end through the real engine tick, because the arithmetic being right
 * and the CENSUS being right are two different claims: the second one is about
 * whether the engine claims an order's slot before or after it awaits.
 *
 * `scanner-refine` owns the dispatcher that will actually select `#needs-refine`
 * cards. Nothing here needs it -- the reservation is a property of the POOL, so
 * plain schedules naming `REFINER@1` prove it exactly as well.
 */

import { describe, expect, test } from 'bun:test'
import { REFINER, REFINER_ORDER_ID, type SeatOrder } from '../../shared/refiner-order'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { createMemoryDriver } from '../store/memory/driver'
import { type EngineDeps, startScheduledTaskEngine } from './engine'
import { applyOrderToRequest } from './fire'
import { MAX_CONCURRENT_SCHEDULED_SPAWNS } from './policy'
import { decideSeatAdmission } from './seat-reservation'

const POOL = MAX_CONCURRENT_SCHEDULED_SPAWNS

function admit(order: SeatOrder | undefined, total: number, forOrder: number) {
  return decideSeatAdmission({ order, census: { total, forOrder }, maxInFlight: POOL })
}

describe('decideSeatAdmission', () => {
  test('the pool is three, and it is three -- the census excludes the fire being decided', () => {
    expect(admit(undefined, 0, 0).admit).toBe(true)
    expect(admit(undefined, 2, 0).admit).toBe(true)
    expect(admit(undefined, 3, 0).admit).toBe(false)
  })

  test('a schedule naming no order is bounded by the global ceiling alone', () => {
    // A queue of refiners cannot stop a schedule that never heard of orders, as
    // long as the pool has room -- reservations are opt-in, not a tax.
    expect(admit(undefined, 2, 9).admit).toBe(true)
  })

  test('REFINER@1 gets its one slot and not the second', () => {
    expect(admit(REFINER, 0, 0).admit).toBe(true)
    const second = admit(REFINER, 1, 1)
    expect(second.admit).toBe(false)
    if (!second.admit) expect(second.reason).toContain(REFINER_ORDER_ID)
  })

  test('the global ceiling is reported before the reservation -- the two fixes are opposite', () => {
    const full = admit(REFINER, POOL, 1)
    expect(full.admit).toBe(false)
    if (!full.admit) expect(full.reason).toContain('concurrency ceiling')
  })

  test('a reservation at or above the pool never binds', () => {
    const greedy: SeatOrder = { ...REFINER, reservation: 99 }
    expect(admit(greedy, 2, 2).admit).toBe(true)
  })

  test('a reservation of zero locks the order out rather than being ignored', () => {
    const parked: SeatOrder = { ...REFINER, reservation: 0 }
    expect(admit(parked, 0, 0).admit).toBe(false)
  })
})

describe('applyOrderToRequest', () => {
  const base: SpawnRequest = { cwd: '/p', prompt: 'refine it' }

  test('no order leaves the request untouched', () => {
    const result = applyOrderToRequest(base, undefined)
    expect(result.ok && result.request).toBe(base)
  })

  test("REFINER@1's caps land on the spawn", () => {
    const result = applyOrderToRequest(base, REFINER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.model).toBe('claude-haiku-4-5')
    expect(result.request.effort).toBe('low')
    expect(result.request.maxBudgetUsd).toBe(0.5)
    // The deny rule is materialized into the settings fragment, unioned with the
    // deny FLOOR rather than replacing it.
    const permissions = (result.request.settingsInline as { permissions?: { deny?: string[] } } | undefined)
      ?.permissions
    expect(permissions?.deny).toContain('mcp__rclaude__project_set_status')
    expect(permissions?.deny?.length ?? 0).toBeGreaterThan(1)
  })

  test('a schedule that already chose a model keeps it -- an order fills gaps, it does not redirect', () => {
    const result = applyOrderToRequest({ ...base, model: 'claude-opus-5' }, REFINER)
    expect(result.ok && result.request.model).toBe('claude-opus-5')
  })

  test('a settingsInline a human configured is not overwritten to add a deny rule', () => {
    const mine = { permissions: { allow: ['Read'] } }
    const result = applyOrderToRequest({ ...base, settingsInline: mine }, REFINER)
    expect(result.ok && result.request.settingsInline).toBe(mine)
  })
})

/** 09:00 Berlin, a Wednesday -- the same due minute `engine.test.ts` uses. */
const DUE = Date.parse('2026-08-12T07:00:00Z')

function makeTask(over: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id: newScheduledTaskId(),
    name: 'sched',
    enabled: true,
    projectUri: 'claude:///p',
    cwd: '/p',
    cron: '0 9 * * *',
    tz: 'Europe/Berlin',
    catchUp: 'skip',
    overlap: 'parallel',
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

/**
 * An engine whose dispatch HANGS until released, so every schedule due in the
 * same minute is genuinely in flight at once. A resolved-immediately dispatch
 * would never let two fires overlap and the ceiling would never be reached.
 */
function hangingEngine(tasks: ScheduledTask[]) {
  const store = createMemoryDriver()
  store.init()
  for (const task of tasks) store.scheduledTasks.upsert(task)
  const requests: SpawnRequest[] = []
  const release: Array<() => void> = []

  const deps: EngineDeps = {
    store,
    now: () => DUE,
    dispatch(req) {
      requests.push(req)
      return new Promise(resolve => {
        release.push(() => resolve({ ok: true, conversationId: `conv_${requests.length}` }))
      })
    },
    isConversationAlive: () => false,
    lastSpawnedConversationId: () => null,
    ownerMaySpawn: () => true,
  }
  const engine = startScheduledTaskEngine(deps)
  return { store, requests, release, engine }
}

function skipReasons(store: ReturnType<typeof createMemoryDriver>, taskId: string): string[] {
  return store.scheduledTasks
    .listRuns(taskId, 20)
    .filter(run => run.outcome === 'skipped_overlap')
    .map(run => run.error ?? '')
}

describe('the reservation, through the real engine tick', () => {
  test('four refiners due in the same minute: ONE dispatches, three are told why', async () => {
    const refiners = [0, 1, 2, 3].map(i => makeTask({ name: `refine ${i}`, orderId: REFINER_ORDER_ID }))
    const { store, requests, release, engine } = hangingEngine(refiners)

    const tick = engine.tick()
    expect(requests).toHaveLength(1)

    const refused = refiners.flatMap(task => skipReasons(store, task.id))
    expect(refused).toHaveLength(3)
    for (const reason of refused) expect(reason).toContain(REFINER_ORDER_ID)

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a refiner backlog cannot crowd out the nightly sweep -- two slots stay reachable', async () => {
    const refiners = [0, 1, 2, 3].map(i => makeTask({ name: `refine ${i}`, orderId: REFINER_ORDER_ID }))
    const sweep = makeTask({ name: 'nightly sweep' })
    const recap = makeTask({ name: 'recap' })
    const { store, requests, release, engine } = hangingEngine([...refiners, sweep, recap])

    const tick = engine.tick()
    // One refiner + both unordered schedules: three of three, and the ones that
    // lost are the refiners, which is the whole point.
    expect(requests).toHaveLength(3)
    expect(skipReasons(store, sweep.id)).toHaveLength(0)
    expect(skipReasons(store, recap.id)).toHaveLength(0)

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a released slot is reclaimable -- the census does not leak', async () => {
    const refiners = [0, 1].map(i => makeTask({ name: `refine ${i}`, orderId: REFINER_ORDER_ID }))
    const { requests, release, engine } = hangingEngine(refiners)

    const tick = engine.tick()
    expect(requests).toHaveLength(1)
    for (const resolve of release) resolve()
    await tick

    // The reserved slot is back. `lastFiredMinuteKey` owns this minute for the
    // one that already fired, so the OTHER schedule proves it via a manual run.
    const other = refiners[1] as ScheduledTask
    const manual = engine.runNow(other.id)
    expect(requests).toHaveLength(2)
    for (const resolve of release) resolve()
    await manual
    engine.stop()
  })

  test('the pool really admits three, not two', async () => {
    const plain = [0, 1, 2].map(i => makeTask({ name: `plain ${i}` }))
    const { requests, release, engine } = hangingEngine(plain)
    const tick = engine.tick()
    expect(requests).toHaveLength(POOL)
    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })
})
