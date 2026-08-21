/**
 * Engine + fire tests -- the tick, the guards, and the run history.
 *
 * Everything runs against the memory driver with an injected clock and a fake
 * dispatch, so a "did it fire, once, with the right request?" question is
 * answered in milliseconds and without a sentinel.
 */

import { beforeEach, describe, expect, test } from 'bun:test'
import { REFINER_ORDER, REFINER_ORDER_ID } from '../../shared/refiner-order'
import { DEFAULT_SCHEDULE_SPAWN, newScheduledTaskId, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { DENY_FLOOR_RULES, denyFloorHookCommand } from '../../shared/unattended-permissions'
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

/** Readers for the settings fragment a fire dispatched with. Shared by the floor
 *  tests and the order/floor composition tests below -- one accessor each, so a
 *  shape change is one edit rather than a hunt through two describes. */
const inlineOf = (req: SpawnRequest) => req.settingsInline as Record<string, unknown>
const permsOf = (req: SpawnRequest) => inlineOf(req).permissions as { allow?: string[]; deny: string[] }
const denyOf = (req: SpawnRequest) => permsOf(req).deny
const hooksOf = (req: SpawnRequest) =>
  inlineOf(req).hooks as { PreToolUse: Array<{ hooks: Array<{ command: string }> }>; SessionStart?: unknown[] }
const guardsOf = (req: SpawnRequest) => hooksOf(req).PreToolUse

/**
 * THE DENY-FLOOR, THROUGH A REAL TICK.
 *
 * Proved here rather than only over `applyDenyFloorToRequest` because the claim
 * is about the POPULATION, not the function: every schedule that fires, whether
 * it names an order, carries its own `settingsInline`, or has never heard of
 * either. The floor being right and the floor being REACHED are two different
 * claims, and until this card only one branch of one order path reached it.
 */
describe('the unattended deny-floor on a scheduled fire', () => {
  test('a schedule naming no order and carrying no fragment still gets the floor', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeTask())

    await h.engine.tick()

    const req = h.requests[0] as SpawnRequest
    for (const rule of DENY_FLOOR_RULES) expect(denyOf(req)).toContain(rule)
    expect(guardsOf(req)[0]?.hooks[0]?.command).toBe(denyFloorHookCommand())
  })

  test('a schedule that configured its own settingsInline keeps it AND gains the floor', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(
      makeTask({
        spawn: {
          ...DEFAULT_SCHEDULE_SPAWN,
          permissionMode: 'dontAsk',
          settingsInline: {
            permissions: { allow: ['Bash(deno test:*)'], deny: ['Bash(terraform apply:*)'] },
            hooks: { SessionStart: [{ matcher: '', hooks: [] }] },
          },
        },
      }),
    )

    await h.engine.tick()

    const req = h.requests[0] as SpawnRequest
    // What the human configured is still there, verbatim.
    expect(permsOf(req).allow).toEqual(['Bash(deno test:*)'])
    expect(denyOf(req)).toContain('Bash(terraform apply:*)')
    expect(hooksOf(req).SessionStart).toHaveLength(1)
    // ...and the floor is now under it.
    expect(denyOf(req)).toContain('Bash(git push origin main:*)')
    expect(guardsOf(req)[0]?.hooks[0]?.command).toBe(denyFloorHookCommand())
  })

  test('a manual "Run now" gets the same floor as the 03:00 fire', async () => {
    const h = harness()
    const task = makeTask({ cron: '0 3 1 1 *' })
    h.store.scheduledTasks.upsert(task)

    await h.engine.runNow(task.id)

    expect(denyOf(h.requests[0] as SpawnRequest)).toContain('Bash(sudo:*)')
  })

  test('a fragment the floor cannot be folded into FAILS the fire rather than being overwritten', async () => {
    const h = harness()
    const task = makeTask({
      spawn: { ...DEFAULT_SCHEDULE_SPAWN, settingsInline: { permissions: { deny: 'Bash(sudo:*)' } } },
    })
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    expect(h.requests).toHaveLength(0)
    const run = h.store.scheduledTasks.listRuns(task.id)[0]
    expect(run?.outcome).toBe('error')
    expect(run?.error).toContain('deny-floor')
    // A refused fire counts toward the backoff, exactly like an over-privileged order.
    expect(h.store.scheduledTasks.get(task.id)?.consecutiveFailures).toBe(1)
  })

  test('a settingsPath with no inline fragment FAILS the fire rather than silently replacing the file', async () => {
    // The sentinel materializes settingsInline and lets it WIN over settingsPath,
    // so writing a floor fragment here would throw the human's file away.
    const h = harness()
    const task = makeTask({ spawn: { ...DEFAULT_SCHEDULE_SPAWN, settingsPath: '/etc/rclaude/nightly.json' } })
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    expect(h.requests).toHaveLength(0)
    expect(h.store.scheduledTasks.listRuns(task.id)[0]?.error).toContain('settingsPath')
  })
})

/**
 * AN ORDER *AND* A FRAGMENT, ON THE SAME FIRE.
 *
 * Two cards a day apart rewrote how deny rules are composed into
 * `settingsInline` in the same function -- `order-deny-union-settings-inline`
 * (the order's rules are unioned into a fragment the caller already wrote) and
 * `sched-settings-inline-deny-floor` (the floor goes on every fire). Each
 * card's tests exercise only its own half: the order tests never see the floor
 * and the floor tests never name an `orderId`. So the merge was textually clean
 * and green while the COMPOSITION of the two was covered by nothing.
 *
 * These tests bind the composition itself: three sources of deny rules (the
 * human's fragment, the order, the floor), stacked in that order, additive,
 * deduped, with everything else in the fragment left alone.
 */
describe('an order and a settingsInline fragment composed on one fire', () => {
  /** The order's own rule. Asserted against `REFINER_ORDER` inside the test, so
   *  an order that stops carrying it fails loudly instead of testing nothing. */
  const ORDER_RULE = 'mcp__rclaude__project_set_status'
  /** The human's own rule -- nobody else carries it. */
  const CALLER_RULE = 'Bash(terraform apply:*)'
  /** The human's SECOND rule, deliberately one the floor also carries: the
   *  dedupe across two layers is only provable when a rule arrives twice. */
  const SHARED_WITH_FLOOR = 'Bash(sudo:*)'

  /** How many times `rule` shows up. `toContain` cannot see a duplicate. */
  const countIn = (rules: string[], rule: string) => rules.filter(r => r === rule).length
  /** PreToolUse entries that ARE the floor's guard hook. */
  const guardCount = (req: SpawnRequest) =>
    guardsOf(req).filter(entry => entry.hooks?.some(hook => hook.command === denyFloorHookCommand())).length

  function orderedTaskWithFragment(deny: string[]): ScheduledTask {
    return makeTask({
      name: 'refine with settings',
      orderId: REFINER_ORDER_ID,
      spawn: {
        ...DEFAULT_SCHEDULE_SPAWN,
        permissionMode: 'dontAsk',
        settingsInline: {
          permissions: { allow: ['Bash(deno test:*)'], deny },
          hooks: { SessionStart: [{ matcher: '', hooks: [] }] },
          // A key neither module has ever heard of. `settingsInline` is an opaque
          // bag by schema, and both layers claim to spread it through untouched.
          statusLine: { type: 'command', command: 'echo scheduled' },
        },
      },
    })
  }

  test("the caller's rules, the order's rule and the whole floor all land, each exactly once", async () => {
    expect(REFINER_ORDER.permissions?.deny).toContain(ORDER_RULE)

    const h = harness()
    h.store.scheduledTasks.upsert(orderedTaskWithFragment([CALLER_RULE, SHARED_WITH_FLOOR]))

    await h.engine.tick()

    expect(h.requests).toHaveLength(1)
    const req = h.requests[0] as SpawnRequest
    const deny = denyOf(req)

    // 1. THE LAYERING CONTRACT, as an exact list: what the human wrote stays at
    //    the head, the order's rule goes on next, the floor last. Asserted as an
    //    array rather than three `toContain`s because the ORDER of the two calls
    //    in `fireSchedule` is precisely what nothing else pins -- swap them and
    //    every membership check still passes.
    expect(deny).toEqual([
      CALLER_RULE,
      SHARED_WITH_FLOOR,
      ORDER_RULE,
      ...DENY_FLOOR_RULES.filter(rule => rule !== SHARED_WITH_FLOOR),
    ])

    // 2. DEDUPE HOLDS ACROSS BOTH LAYERS. `SHARED_WITH_FLOOR` arrived from the
    //    human AND from the floor; it is in the list once.
    expect(countIn(deny, SHARED_WITH_FLOOR)).toBe(1)
    expect(countIn(deny, CALLER_RULE)).toBe(1)
    expect(countIn(deny, ORDER_RULE)).toBe(1)
    expect(deny).toHaveLength(new Set(deny).size)

    // 3. EVERYTHING ELSE IN THE FRAGMENT SURVIVES -- the allowlist the human
    //    configured, their unrelated hook, and a key neither layer knows about.
    expect(permsOf(req).allow).toEqual(['Bash(deno test:*)'])
    expect(hooksOf(req).SessionStart).toHaveLength(1)
    expect(inlineOf(req).statusLine).toEqual({ type: 'command', command: 'echo scheduled' })

    // 4. ONE guard hook, not two. Both layers can add it; only one may.
    expect(guardCount(req)).toBe(1)
  })

  test("a caller that already denies the order's own rule gets it once, and still gets the floor", async () => {
    // The union short-circuits here -- the order adds nothing new, so
    // `applyOrderToRequest` leaves the fragment alone entirely. The floor is a
    // separate step and must land anyway.
    const h = harness()
    h.store.scheduledTasks.upsert(orderedTaskWithFragment([ORDER_RULE]))

    await h.engine.tick()

    const req = h.requests[0] as SpawnRequest
    expect(countIn(denyOf(req), ORDER_RULE)).toBe(1)
    for (const rule of DENY_FLOOR_RULES) expect(countIn(denyOf(req), rule)).toBe(1)
    expect(permsOf(req).allow).toEqual(['Bash(deno test:*)'])
    expect(guardCount(req)).toBe(1)
  })

  test("an order refusal ends the fire with the ORDER's reason -- the floor is never reached", async () => {
    // A `deny` that is a string, not an array of strings: BOTH layers refuse
    // this fragment, with different reasons, which is what makes it an ordering
    // probe. The same fixture without an `orderId` fails on the floor instead
    // (see "a fragment the floor cannot be folded into FAILS the fire" above).
    const h = harness()
    const task = makeTask({
      name: 'refine with junk settings',
      orderId: REFINER_ORDER_ID,
      spawn: { ...DEFAULT_SCHEDULE_SPAWN, settingsInline: { permissions: { deny: 'Bash(sudo:*)' } } },
    })
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()

    expect(h.requests).toHaveLength(0)
    const run = h.store.scheduledTasks.listRuns(task.id)[0]
    expect(run?.outcome).toBe('error')
    expect(run?.error).toContain(`order ${REFINER_ORDER_ID}`)
    expect(run?.error).toContain('cannot apply its deny rules')
    // The floor never got a say: its refusal wording is absent.
    expect(run?.error).not.toContain('deny-floor')
    // A refused fire still counts toward the backoff.
    expect(h.store.scheduledTasks.get(task.id)?.consecutiveFailures).toBe(1)
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

describe('one-shot end to end', () => {
  /** A one-shot due at DUE, in the same harness as the recurring tests. */
  function makeOnce(over: Partial<ScheduledTask> = {}): ScheduledTask {
    const { cron: _dropped, ...rest } = makeTask(over)
    return { ...rest, runAt: over.runAt ?? DUE }
  }

  test('fires once at its moment and never again', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()
    expect(h.requests).toHaveLength(1)

    // ...and keeps not firing, at every later tick.
    for (const offset of [60_000, 3_600_000, 86_400_000]) {
      h.nowMs = DUE + offset
      await h.engine.tick()
    }
    expect(h.requests).toHaveLength(1)
  })

  test('disarms itself after firing, so it stops being walked', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()
    h.nowMs = DUE + 60_000
    await h.engine.tick()

    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
  })

  test('the record SURVIVES -- disarmed, not deleted, so history is readable', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    await h.engine.tick()
    h.nowMs = DUE + 60_000
    await h.engine.tick()

    expect(h.store.scheduledTasks.get(task.id)).not.toBeNull()
    expect(h.store.scheduledTasks.listRuns(task.id).map(r => r.outcome)).toContain('spawned')
  })

  test('does not fire early', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeOnce())
    h.nowMs = DUE - 60_000
    await h.engine.tick()
    expect(h.requests).toHaveLength(0)
  })

  test('fires late after an outage inside the grace window', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeOnce())
    h.nowMs = DUE + 30 * 60_000 // broker was down over the moment
    await h.engine.tick()
    expect(h.requests).toHaveLength(1)
  })

  test('a stale one-shot records WHY it never ran, then disarms', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    h.nowMs = DUE + 8 * 3_600_000 // well past the 6h grace
    await h.engine.tick()

    expect(h.requests).toHaveLength(0)
    const runs = h.store.scheduledTasks.listRuns(task.id)
    expect(runs[0]?.outcome).toBe('missed')
    expect(runs[0]?.error).toContain('too stale')
    expect(h.store.scheduledTasks.get(task.id)?.enabled).toBe(false)
  })

  test('the stale row is written ONCE, not on every subsequent tick', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    h.nowMs = DUE + 8 * 3_600_000
    await h.engine.tick()
    await h.engine.tick()
    h.nowMs = DUE + 9 * 3_600_000
    await h.engine.tick()

    expect(h.store.scheduledTasks.listRuns(task.id, 50)).toHaveLength(1)
  })

  test('Run now still works on a one-shot and does not consume its moment', async () => {
    const h = harness()
    const task = makeOnce()
    h.store.scheduledTasks.upsert(task)

    await h.engine.runNow(task.id)
    expect(h.requests).toHaveLength(1)

    // The scheduled moment is still owed, and still arrives.
    await h.engine.tick()
    expect(h.requests).toHaveLength(2)
    const triggers = h.store.scheduledTasks.listRuns(task.id).map(r => r.trigger)
    expect(triggers.filter(t => t === 'manual')).toHaveLength(1)
    expect(triggers.filter(t => t === 'cron')).toHaveLength(1)
  })

  test('a one-shot and a cron schedule coexist in one tick', async () => {
    const h = harness()
    h.store.scheduledTasks.upsert(makeTask({ cwd: '/cron' }))
    h.store.scheduledTasks.upsert(makeOnce({ cwd: '/once' }))
    await h.engine.tick()
    expect(h.requests.map(r => r.cwd).sort()).toEqual(['/cron', '/once'])
  })
})
