/**
 * THE RESERVATION -- proved twice, at two altitudes.
 *
 * First as a table over the pure decision, because the interesting case is four
 * werkRefiners due in the same minute and that is arithmetic, not a race. Then
 * end-to-end through the real engine tick, because the arithmetic being right
 * and the CENSUS being right are two different claims: the second one is about
 * whether the engine claims an order's slot before or after it awaits.
 *
 * `scanner-refine` owns the dispatcher that will actually select `#needs-refine`
 * cards. Nothing here needs it -- the reservation is a property of the POOL, so
 * plain schedules naming `WERK-REFINER@1` prove it exactly as well.
 */

import { describe, expect, test } from 'bun:test'
import type { Order } from '../../shared/order'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { WERK_REFINER_INSTRUCTIONS, WERK_REFINER_ORDER, WERK_REFINER_ORDER_ID } from '../../shared/werk-refiner-order'
import { createMemoryDriver } from '../store/memory/driver'
import { type EngineDeps, startScheduledTaskEngine } from './engine'
import { applyOrderToRequest } from './fire'
import { MAX_CONCURRENT_SCHEDULED_SPAWNS } from './policy'
import { decideSeatAdmission } from './seat-reservation'

const POOL = MAX_CONCURRENT_SCHEDULED_SPAWNS

function admit(order: Order | undefined, total: number, forOrder: number) {
  return decideSeatAdmission({ order, census: { total, forOrder }, maxInFlight: POOL })
}

describe('decideSeatAdmission', () => {
  test('the pool is three, and it is three -- the census excludes the fire being decided', () => {
    expect(admit(undefined, 0, 0).admit).toBe(true)
    expect(admit(undefined, 2, 0).admit).toBe(true)
    expect(admit(undefined, 3, 0).admit).toBe(false)
  })

  test('a schedule naming no order is bounded by the global ceiling alone', () => {
    // A queue of werkRefiners cannot stop a schedule that never heard of orders, as
    // long as the pool has room -- reservations are opt-in, not a tax.
    expect(admit(undefined, 2, 9).admit).toBe(true)
  })

  test('WERK-REFINER@1 gets its one slot and not the second', () => {
    expect(admit(WERK_REFINER_ORDER, 0, 0).admit).toBe(true)
    const second = admit(WERK_REFINER_ORDER, 1, 1)
    expect(second.admit).toBe(false)
    if (!second.admit) expect(second.reason).toContain(WERK_REFINER_ORDER_ID)
  })

  test('the global ceiling is reported before the reservation -- the two fixes are opposite', () => {
    const full = admit(WERK_REFINER_ORDER, POOL, 1)
    expect(full.admit).toBe(false)
    if (!full.admit) expect(full.reason).toContain('concurrency ceiling')
  })

  test('a reservation at or above the pool never binds', () => {
    const greedy: Order = { ...WERK_REFINER_ORDER, reservation: 99 }
    expect(admit(greedy, 2, 2).admit).toBe(true)
  })

  test('a reservation of zero locks the order out rather than being ignored', () => {
    const parked: Order = { ...WERK_REFINER_ORDER, reservation: 0 }
    expect(admit(parked, 0, 0).admit).toBe(false)
  })

  test('an order that DECLARES no reservation is bounded by the global ceiling alone', () => {
    // `Order.reservation` is optional now that it lives on the artifact rather
    // than on a wrapper that made it mandatory. Absent has to mean UNRESERVED:
    // an order that never mentioned the scheduler's pool did not ask for a
    // share of it, and picking a number for it here would be the broker
    // deciding again what a seat is.
    const { reservation: _dropped, ...unreserved } = WERK_REFINER_ORDER
    expect(admit(unreserved, 2, 2).admit).toBe(true)
  })
})

describe('applyOrderToRequest', () => {
  const base: SpawnRequest = { cwd: '/p', prompt: 'refine it' }

  test('no order leaves the request untouched', () => {
    const result = applyOrderToRequest(base, undefined)
    expect(result.ok && result.request).toBe(base)
  })

  test("WERK-REFINER@1's caps land on the spawn", () => {
    const result = applyOrderToRequest(base, WERK_REFINER_ORDER)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.request.model).toBe('claude-haiku-4-5')
    expect(result.request.effort).toBe('low')
    expect(result.request.maxBudgetUsd).toBe(0.5)
    // THE TURN CEILING, which used to be a number on a wrapper type that nothing
    // downstream read. It composes exactly like the budget and lands on the same
    // request, which is what the sentinel turns into `--max-turns`.
    expect(result.request.maxTurns).toBe(30)
    // The deny rule is materialized into the settings fragment, unioned with the
    // deny FLOOR rather than replacing it.
    const permissions = (result.request.settingsInline as { permissions?: { deny?: string[] } } | undefined)
      ?.permissions
    expect(permissions?.deny).toContain('mcp__rclaude__project_set_status')
    expect(permissions?.deny?.length ?? 0).toBeGreaterThan(1)
  })

  test('a schedule that already chose a model keeps it -- an order fills gaps, it does not redirect', () => {
    const result = applyOrderToRequest({ ...base, model: 'claude-opus-5' }, WERK_REFINER_ORDER)
    expect(result.ok && result.request.model).toBe('claude-opus-5')
  })

  test('a TIGHTER turn cap on the request wins -- an order narrows, it never raises', () => {
    const tighter = applyOrderToRequest({ ...base, maxTurns: 5 }, WERK_REFINER_ORDER)
    expect(tighter.ok && tighter.request.maxTurns).toBe(5)
    // ...and a looser one is pulled back down to the order's.
    const looser = applyOrderToRequest({ ...base, maxTurns: 500 }, WERK_REFINER_ORDER)
    expect(looser.ok && looser.request.maxTurns).toBe(30)
  })

  /**
   * THE UNION, which is this describe block's reason to exist.
   *
   * `WERK-REFINER@1`'s claim to being trustworthy is structural: the seat CANNOT
   * call the status verb. A fragment the caller already set used to make the
   * order skip its deny rules entirely, which turned that structural guarantee
   * back into a comment. Every test below fails if the skip returns.
   */
  describe("a settingsInline the caller already set is UNIONED with the order's deny rules", () => {
    const denyOf = (request: SpawnRequest): string[] | undefined =>
      (request.settingsInline as { permissions?: { deny?: string[] } } | undefined)?.permissions?.deny

    test("the caller's own fragment still delivers the order's deny rule", () => {
      const mine = { permissions: { allow: ['Read'], deny: ['Bash(rm:*)'] } }
      const result = applyOrderToRequest({ ...base, settingsInline: mine }, WERK_REFINER_ORDER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(denyOf(result.request)).toContain('mcp__rclaude__project_set_status')
      // UNIONED, not replaced -- the caller's rule survives alongside it.
      expect(denyOf(result.request)).toContain('Bash(rm:*)')
    })

    test('everything else in the fragment is left exactly as the caller wrote it', () => {
      const hooks = { PreToolUse: [{ matcher: '', hooks: [] }] }
      const mine = { permissions: { allow: ['Read'], defaultMode: 'plan' }, hooks, env: { A: '1' } }
      const result = applyOrderToRequest({ ...base, settingsInline: mine }, WERK_REFINER_ORDER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      const settings = result.request.settingsInline as {
        permissions: { allow: string[]; defaultMode: string }
        hooks: unknown
        env: unknown
      }
      expect(denyOf(result.request)).toContain('mcp__rclaude__project_set_status')
      expect(settings.permissions.allow).toEqual(['Read'])
      expect(settings.permissions.defaultMode).toBe('plan')
      expect(settings.hooks).toBe(hooks)
      expect(settings.env).toEqual({ A: '1' })
      // ...and the caller's object itself is never mutated in place.
      expect(mine.permissions).not.toHaveProperty('deny')
    })

    test('a fragment with no permissions block at all gets one', () => {
      const result = applyOrderToRequest({ ...base, settingsInline: { env: { A: '1' } } }, WERK_REFINER_ORDER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(denyOf(result.request)).toEqual(['mcp__rclaude__project_set_status'])
    })

    test('a fragment that already carries the rule is handed back untouched', () => {
      const mine = { permissions: { deny: ['mcp__rclaude__project_set_status'] } }
      const result = applyOrderToRequest({ ...base, settingsInline: mine }, WERK_REFINER_ORDER)
      expect(result.ok && result.request.settingsInline).toBe(mine)
    })

    test('a caller who repeated a rule in its own deny list still gets the order rule', () => {
      // The "did the order add anything" check is MEMBERSHIP, not list length:
      // ['A','A'] dedupes to one entry, so a length test would read the union
      // as a no-op and skip the write.
      const mine = { permissions: { deny: ['Bash(rm:*)', 'Bash(rm:*)'] } }
      const result = applyOrderToRequest({ ...base, settingsInline: mine }, WERK_REFINER_ORDER)
      expect(result.ok).toBe(true)
      if (!result.ok) return
      expect(denyOf(result.request)).toContain('mcp__rclaude__project_set_status')
    })

    test('a permissions block that is not an object FAILS the fire, naming the order', () => {
      const result = applyOrderToRequest({ ...base, settingsInline: { permissions: 'nope' } }, WERK_REFINER_ORDER)
      expect(result.ok).toBe(false)
      if (result.ok) return
      expect(result.reason).toContain(WERK_REFINER_ORDER_ID)
      expect(result.reason).toContain('settingsInline.permissions')
    })

    test('a deny that is not an array of strings FAILS the fire rather than being overwritten', () => {
      const bad = applyOrderToRequest(
        { ...base, settingsInline: { permissions: { deny: [1, 2] } } },
        WERK_REFINER_ORDER,
      )
      expect(bad.ok).toBe(false)
      if (bad.ok) return
      expect(bad.reason).toContain(WERK_REFINER_ORDER_ID)
      expect(bad.reason).toContain('deny')

      const worse = applyOrderToRequest(
        { ...base, settingsInline: { permissions: { deny: 'all' } } },
        WERK_REFINER_ORDER,
      )
      expect(worse.ok).toBe(false)
    })
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
  test('four werkRefiners due in the same minute: ONE dispatches, three are told why', async () => {
    const werkRefiners = [0, 1, 2, 3].map(i => makeTask({ name: `refine ${i}`, orderId: WERK_REFINER_ORDER_ID }))
    const { store, requests, release, engine } = hangingEngine(werkRefiners)

    const tick = engine.tick()
    expect(requests).toHaveLength(1)

    const refused = werkRefiners.flatMap(task => skipReasons(store, task.id))
    expect(refused).toHaveLength(3)
    for (const reason of refused) expect(reason).toContain(WERK_REFINER_ORDER_ID)

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a werk-refiner backlog cannot crowd out the nightly sweep -- two slots stay reachable', async () => {
    const werkRefiners = [0, 1, 2, 3].map(i => makeTask({ name: `refine ${i}`, orderId: WERK_REFINER_ORDER_ID }))
    const sweep = makeTask({ name: 'nightly sweep' })
    const recap = makeTask({ name: 'recap' })
    const { store, requests, release, engine } = hangingEngine([...werkRefiners, sweep, recap])

    const tick = engine.tick()
    // One werk-refiner + both unordered schedules: three of three, and the ones that
    // lost are the werkRefiners, which is the whole point.
    expect(requests).toHaveLength(3)
    expect(skipReasons(store, sweep.id)).toHaveLength(0)
    expect(skipReasons(store, recap.id)).toHaveLength(0)

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a released slot is reclaimable -- the census does not leak', async () => {
    const werkRefiners = [0, 1].map(i => makeTask({ name: `refine ${i}`, orderId: WERK_REFINER_ORDER_ID }))
    const { requests, release, engine } = hangingEngine(werkRefiners)

    const tick = engine.tick()
    expect(requests).toHaveLength(1)
    for (const resolve of release) resolve()
    await tick

    // The reserved slot is back. `lastFiredMinuteKey` owns this minute for the
    // one that already fired, so the OTHER schedule proves it via a manual run.
    const other = werkRefiners[1] as ScheduledTask
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

/**
 * The union again, at the altitude that matters: a REAL schedule carrying its
 * own `settingsInline`, fired by the real engine. `applyOrderToRequest` being
 * right and the SEAT THAT ACTUALLY LAUNCHES being right are two claims, and the
 * second one is the one the board cares about.
 */
describe('a scheduled fire whose request already carries settingsInline', () => {
  test('the dispatched seat still cannot call the status verb', async () => {
    const task = makeTask({
      name: 'refine with settings',
      orderId: WERK_REFINER_ORDER_ID,
      spawn: { ...DEFAULT_SCHEDULE_SPAWN, settingsInline: { permissions: { allow: ['Read'] } } },
    })
    const { requests, release, engine } = hangingEngine([task])

    const tick = engine.tick()
    expect(requests).toHaveLength(1)
    const permissions = (requests[0]?.settingsInline as { permissions?: { allow?: string[]; deny?: string[] } })
      ?.permissions
    expect(permissions?.deny).toContain('mcp__rclaude__project_set_status')
    expect(permissions?.allow).toEqual(['Read'])

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a fragment the order cannot union is a FAILED fire, not a downgraded seat', async () => {
    const task = makeTask({
      name: 'refine with junk settings',
      orderId: WERK_REFINER_ORDER_ID,
      spawn: { ...DEFAULT_SCHEDULE_SPAWN, settingsInline: { permissions: { deny: 'everything' } } },
    })
    const { store, requests, engine } = hangingEngine([task])

    await engine.tick()
    // Nothing was dispatched, and the run row says which order refused.
    expect(requests).toHaveLength(0)
    const runs = store.scheduledTasks.listRuns(task.id, 20)
    expect(runs).toHaveLength(1)
    expect(runs[0]?.outcome).toBe('error')
    expect(runs[0]?.error).toContain(WERK_REFINER_ORDER_ID)
    // A failed fire counts against the schedule, so one nobody fixes disarms.
    expect(store.scheduledTasks.get(task.id)?.consecutiveFailures).toBe(1)
    engine.stop()
  })
})

/**
 * THE INSTRUCTION BLOCK REACHES THE SEAT THAT LAUNCHES -- the half of `order@1`
 * that was inert.
 *
 * An order for a seat no broker builder covers carries its own `instructions`.
 * Validating that field and delivering it to nobody would leave a scheduled
 * `WERK-REFINER@1` running on a werk-refiner's BUDGET while never having been told what
 * refining is -- caps without a definition. So the assertion is made where it
 * counts: on the `SpawnRequest` the engine actually handed to dispatch.
 */
describe('an order that carries its own instructions', () => {
  test('the dispatched seat is handed the block, after the schedule’s own prompt', async () => {
    const task = makeTask({ name: 'refine', orderId: WERK_REFINER_ORDER_ID, prompt: 'REFINE the card `foo`.' })
    const { requests, release, engine } = hangingEngine([task])

    const tick = engine.tick()
    expect(requests).toHaveLength(1)
    const prompt = requests[0]?.prompt ?? ''
    // The schedule's own prompt survives -- the order appends, never replaces.
    expect(prompt.startsWith('REFINE the card `foo`.')).toBe(true)
    // And the seat's definition arrives with it, whole -- caps without a
    // definition is a werk-refiner spending a werk-refiner's budget having never
    // been told what refining is.
    expect(prompt).toContain(WERK_REFINER_INSTRUCTIONS)
    // THE TAG REMOVAL IS NOT IN IT, and that is the assertion now. It used to be
    // step 7 of the block, so a seat killed at step 6 left the queue entry on the
    // board forever; the engine drains it on evidence instead (`tag-clear.ts`),
    // and a scheduled werk-refiner must not be handed a second, earlier mechanism.
    expect(prompt).not.toContain('REMOVE the `needs-refine` tag')

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test("the dispatched seat carries the order's turn ceiling, not just its budget", async () => {
    const task = makeTask({ name: 'refine', orderId: WERK_REFINER_ORDER_ID, prompt: 'REFINE the card `foo`.' })
    const { requests, release, engine } = hangingEngine([task])

    const tick = engine.tick()
    expect(requests[0]?.maxTurns).toBe(WERK_REFINER_ORDER.caps.maxTurns)
    expect(requests[0]?.maxBudgetUsd).toBe(WERK_REFINER_ORDER.caps.maxBudgetUsd)

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })

  test('a schedule naming NO order gets its prompt verbatim', async () => {
    const task = makeTask({ name: 'plain', prompt: 'just do the thing' })
    const { requests, release, engine } = hangingEngine([task])

    const tick = engine.tick()
    expect(requests[0]?.prompt).toBe('just do the thing')

    for (const resolve of release) resolve()
    await tick
    engine.stop()
  })
})
