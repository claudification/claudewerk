/**
 * SCHEDULED TASKS ENGINE -- the minute tick.
 *
 * Once a minute it walks every ENABLED schedule, asks `decideFire` whether this
 * wall-clock minute matches (in the schedule's own zone -- the container is UTC),
 * and hands the due ones to `fireSchedule`.
 *
 * Modelled on `nightshift-scheduler.ts`: same 60s cadence, same `{stop}` handle,
 * same injectable `now` for tests. The one idiom worth copying deliberately is
 * stamping the fire marker BEFORE the await -- a dispatch that takes longer than
 * a tick must not be fired twice.
 *
 * On boot it reconciles missed fires (§catch-up): the broker was down or the
 * machine was asleep, and the honest thing is to RECORD the gap rather than
 * pretend it did not happen or replay it all at once.
 */

import { minuteKey, wallClockParts } from '../../shared/cron-time'
import { SCHEDULE_RUN_RETENTION, SCHEDULE_RUN_RETENTION_MS, type ScheduledTask } from '../../shared/scheduled-task'
import type { StoreDriver } from '../store/types'
import { reconcileMissedFires } from './catch-up'
import { type FireDeps, fireSchedule } from './fire'
import { decideFire, isTerminalSkip, MAX_CONCURRENT_SCHEDULED_SPAWNS } from './policy'

const TICK_MS = 60_000
/** History pruning is cheap but pointless to run every minute. */
const PRUNE_EVERY_TICKS = 60

export interface EngineDeps extends Omit<FireDeps, 'persist' | 'recordRun' | 'inFlight' | 'maxInFlight' | 'now'> {
  store: StoreDriver
  now?: () => number
  maxInFlight?: number
  /** Fired after any schedule changes so the control panel can re-render. */
  onScheduleChanged?(task: ScheduledTask): void
  onRunRecorded?(scheduleId: string): void
}

export interface ScheduledTaskEngine {
  stop(): void
  /** Fire one schedule right now, bypassing the clock. Powers the "Run now" button. */
  runNow(scheduleId: string): Promise<{ ok: boolean; error?: string }>
  /** Exposed for tests: run one tick synchronously. */
  tick(): Promise<void>
}

export function startScheduledTaskEngine(deps: EngineDeps): ScheduledTaskEngine {
  const now = deps.now ?? Date.now
  const store = deps.store
  const maxInFlight = deps.maxInFlight ?? MAX_CONCURRENT_SCHEDULED_SPAWNS
  /** Schedules with a dispatch in flight -- a slow spawn must not double-fire. */
  const firing = new Set<string>()
  let ticks = 0

  const fireDeps: FireDeps = {
    ...deps,
    maxInFlight,
    now,
    inFlight: () => firing.size,
    persist(task) {
      store.scheduledTasks.upsert(task)
      deps.onScheduleChanged?.(task)
    },
    recordRun(run) {
      store.scheduledTasks.addRun(run)
      deps.onRunRecorded?.(run.scheduleId)
    },
    lastSpawnedConversationId(scheduleId) {
      // The most recent run that actually launched something.
      for (const run of store.scheduledTasks.listRuns(scheduleId, 20)) {
        if (run.outcome === 'spawned' && run.conversationId) return run.conversationId
      }
      return null
    },
  }

  /**
   * Claim the fire, then run it. For clock-driven fires the marker is written
   * BEFORE the await, so a dispatch slower than one tick cannot be fired twice.
   *
   * A MANUAL run deliberately does not touch the marker: overwriting it would
   * free the current minute to fire again on the very next tick, turning
   * "Run now" during a scheduled minute into a double launch.
   */
  async function claimAndFire(
    task: ScheduledTask,
    key: string,
    trigger: 'cron' | 'manual' | 'catchup',
    opts: { stampMarker: boolean; firedAt?: number },
  ) {
    firing.add(task.id)
    const claimed: ScheduledTask = opts.stampMarker ? { ...task, lastFiredMinuteKey: key, updatedAt: now() } : task
    if (opts.stampMarker) store.scheduledTasks.upsert(claimed)
    try {
      await fireSchedule(claimed, fireDeps, { trigger, minuteKey: key, firedAt: opts.firedAt })
    } finally {
      firing.delete(task.id)
    }
  }

  /** Disarm a schedule that can never fire again, so it stops being walked. */
  function disarm(task: ScheduledTask, reason: string): void {
    console.log(`[sched] disarm id=${task.id} name="${task.name}" reason=${reason}`)
    fireDeps.persist({ ...task, enabled: false, updatedAt: now() })
  }

  async function considerOne(task: ScheduledTask, nowMs: number): Promise<void> {
    if (firing.has(task.id)) return
    const decision = decideFire(task, nowMs)
    if (!decision.fire) {
      if (isTerminalSkip(decision.reason)) disarm(task, decision.reason)
      else if (decision.reason === 'bad_cron') {
        console.warn(`[sched] id=${task.id} name="${task.name}" has an unparseable cron "${task.cron}" -- not firing`)
      }
      return
    }
    await claimAndFire(task, decision.minuteKey, 'cron', { stampMarker: true })
  }

  async function tick(): Promise<void> {
    const nowMs = now()
    ticks++
    // Fires run CONCURRENTLY: awaiting each in turn would let one slow dispatch
    // delay every other schedule's evaluation past its minute. The `firing` set
    // is what keeps a single schedule from overlapping itself.
    const pending: Promise<void>[] = []
    for (const task of store.scheduledTasks.list({ enabledOnly: true })) {
      pending.push(
        // One bad schedule must never take the tick down for the others.
        considerOne(task, nowMs).catch(err => console.error(`[sched] consider crashed id=${task.id}:`, err)),
      )
    }
    await Promise.all(pending)
    if (ticks % PRUNE_EVERY_TICKS === 0) {
      const removed = store.scheduledTasks.pruneRuns(SCHEDULE_RUN_RETENTION, nowMs - SCHEDULE_RUN_RETENTION_MS)
      if (removed > 0) console.log(`[sched] pruned ${removed} run rows`)
    }
  }

  async function runNow(scheduleId: string): Promise<{ ok: boolean; error?: string }> {
    const task = store.scheduledTasks.get(scheduleId)
    if (!task) return { ok: false, error: 'schedule not found' }
    if (firing.has(task.id)) return { ok: false, error: 'this schedule is already firing' }
    const nowMs = now()
    // Labelled with the schedule's own clock for the history, but NOT gated on
    // the cron matching -- firing off-schedule is the entire point of the button.
    const key = `${minuteKey(wallClockParts(nowMs, task.tz), task.tz)}#manual`
    await claimAndFire(task, key, 'manual', { stampMarker: false, firedAt: nowMs })
    return { ok: true }
  }

  reconcileMissedFires({
    store,
    now,
    onRunRecorded: deps.onRunRecorded,
    fireCatchUp: (task, key) => claimAndFire(task, key, 'catchup', { stampMarker: true }),
  }).catch(err => console.error('[sched] boot reconcile crashed:', err))
  tick().catch(err => console.error('[sched] boot tick crashed:', err))
  const timer = setInterval(() => {
    tick().catch(err => console.error('[sched] tick crashed:', err))
  }, TICK_MS)

  return {
    stop: () => clearInterval(timer),
    runNow,
    tick,
  }
}
