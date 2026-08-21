/**
 * FIRING a schedule -- resolve the spawn, check the owner still may, dispatch,
 * and record what happened either way.
 *
 * Every path through here writes a RUN row. A fire that was skipped for overlap,
 * refused for permissions, or blew up in dispatch is history the user can see in
 * the modal; silently doing nothing would make a schedule that never runs
 * indistinguishable from one that runs fine.
 *
 * Dependencies are injected rather than imported, so this tests without a broker,
 * a sentinel, or a clock. `engine.ts` supplies the real ones.
 */

import type { LaunchProfile } from '../../shared/launch-profile'
import { composeOrderCaps, internalOrderCaller } from '../../shared/order-caps'
import { type SeatOrder, seatOrder } from '../../shared/refiner-order'
import { newScheduledRunId, type RunOutcome, type RunTrigger, type ScheduledRun } from '../../shared/scheduled-run'
import { isSpawnSchedule, type ScheduledTask } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { buildUnattendedSettings } from '../../shared/unattended-permissions'
import { nextFailureState } from './policy'
import { decideSeatAdmission } from './seat-reservation'

export interface DispatchOutcome {
  ok: boolean
  conversationId?: string
  jobId?: string
  error?: string
}

export interface FireDeps {
  /** Dispatch a spawn. Mirrors `dispatchSpawn`'s result shape. */
  dispatch(req: SpawnRequest): Promise<DispatchOutcome>
  /** Is this conversation still running? Drives the overlap policy. */
  isConversationAlive(conversationId: string): boolean
  /** The conversation spawned by this schedule's most recent `spawned` run. */
  lastSpawnedConversationId(scheduleId: string): string | null
  /** Does this user still hold the `spawn` permission? Re-checked at every fire. */
  ownerMaySpawn(userName: string): boolean
  /** Optional launch-profile base the schedule inherits from. */
  getLaunchProfile?(profileId: string, userName: string): LaunchProfile | null
  persist(task: ScheduledTask): void
  recordRun(run: ScheduledRun): void
  /** Dispatched-and-unsettled scheduler spawns, for the global ceiling. */
  inFlight(): number
  /** Of those, how many run under this order id -- the reservation's counter. */
  inFlightForOrder(orderId: string): number
  /**
   * Take a slot for a dispatch that is about to start; returns its release.
   *
   * SEPARATE FROM THE DOUBLE-FIRE GUARD ON PURPOSE. The engine's `firing` set
   * holds a schedule from the moment it is CONSIDERED, refusals included, and
   * counting that as occupancy makes every refusal cost a slot it never used.
   * A slot is taken here, between admission and dispatch, with no await in
   * between -- so the next schedule in the same tick sees it.
   */
  claimSlot(orderId: string | undefined): () => void
  maxInFlight: number
  /**
   * Run the morning report's board op for a `board-sweep` schedule.
   *
   * OPTIONAL because the engine is dependency-injected and most of its tests
   * arm nothing but spawns. Absent when a `board-sweep` schedule fires is a
   * FAILED fire with a reason, never a silent no-op -- a schedule that quietly
   * does nothing is indistinguishable from one that works.
   */
  runBoardSweep?(task: ScheduledTask): Promise<DispatchOutcome>
  /**
   * Is the morning report opted in for this project? OFF BY DEFAULT: absent, or
   * returning false, refuses the fire. A sweep that switched itself on would be
   * an unattended agent re-filing cards in a repo nobody opted in.
   */
  morningReportEnabled?(projectUri: string): boolean
  notify?(message: string): void
  now(): number
}

export interface FireOptions {
  trigger: RunTrigger
  minuteKey: string
  /** The instant this fire represents -- a catch-up is not "now". */
  firedAt?: number
}

export interface FireResult {
  outcome: RunOutcome
  conversationId?: string
  error?: string
}

/**
 * Build the spawn request: launch profile underneath, the schedule's own `spawn`
 * on top, and the fields the schedule OWNS applied last so nothing inherited can
 * redirect the target or replace the prompt.
 */
export function buildSpawnRequest(task: ScheduledTask, profile: LaunchProfile | null, firedAt: number): SpawnRequest {
  const stamp = new Date(firedAt).toISOString().slice(0, 16).replace('T', ' ')
  return {
    ...(profile?.spawn ?? {}),
    ...task.spawn,
    cwd: task.cwd,
    // `?? ''` never fires for a spawn schedule -- `checkAction` rejects one with
    // no prompt at both create and PATCH. It is here because the field became
    // optional for `board-sweep`, which does not reach this function at all.
    prompt: task.prompt ?? '',
    sentinel: task.sentinel ?? profile?.sentinel,
    name: `${task.name} ${stamp}`.slice(0, 80),
    description: `Scheduled run of "${task.name}" (${task.cron} ${task.tz})`,
  }
}

export type OrderApplication = { ok: true; request: SpawnRequest } | { ok: false; reason: string }

/**
 * Layer a work order's caps onto a spawn request.
 *
 * THE ORDER NEVER WINS OVER AN EXPLICIT CHOICE and never widens anything --
 * both rules belong to `composeOrderCaps`, which is called rather than
 * re-implemented so a scheduled seat gets byte-identical refusals to an epic
 * seat. What is left here is the mapping back onto a `SpawnRequest`.
 *
 * The deny rules go through `buildUnattendedSettings`, which is also where the
 * deny FLOOR lives, so an order's rules land unioned with the floor rather than
 * replacing it. A schedule that already carries its own `settingsInline` keeps
 * it: overwriting a fragment a human configured, to add one deny rule, would be
 * the order rewriting the harness.
 */
export function applyOrderToRequest(request: SpawnRequest, order: SeatOrder | undefined): OrderApplication {
  if (order === undefined) return { ok: true, request }
  const composed = composeOrderCaps(
    order.order,
    {
      model: request.model,
      effort: request.effort,
      agent: request.agent,
      mcpConfigPath: request.mcpConfigPath,
      maxBudgetUsd: request.maxBudgetUsd,
      permissionMode: request.permissionMode as never,
    },
    internalOrderCaller(),
  )
  if (!composed.ok) return { ok: false, reason: composed.reason }

  const { deny, ...caps } = composed.caps
  const next: SpawnRequest = { ...request, ...caps }
  if (deny?.length && request.settingsInline === undefined) {
    next.settingsInline = buildUnattendedSettings({ deny })
  }
  return { ok: true, request: next }
}

/**
 * WHAT this fire actually does, resolved before a slot is claimed.
 *
 * Two actions, one fire path. Everything around this -- the owner re-check, the
 * overlap rule, seat admission, the run row, the failure backoff -- is shared
 * because those are rules about firing unattended work, and none of them is a
 * rule about spawning. Only the middle differs, so only the middle branches.
 */
type FirePlan =
  | { ok: true; run: () => Promise<DispatchOutcome>; outcome: RunOutcome }
  | { ok: false; reason: string }

function planFire(task: ScheduledTask, deps: FireDeps, firedAt: number, order: SeatOrder | undefined): FirePlan {
  if (!isSpawnSchedule(task)) {
    // A `board-sweep` with no runner is a FAILED fire with a reason, never a
    // quiet success -- see `FireDeps.runBoardSweep`.
    const run = deps.runBoardSweep
    if (!run) return { ok: false, reason: 'this broker has no board-sweep runner wired' }
    return { ok: true, run: () => run(task), outcome: 'swept' }
  }

  const profile = task.profileId ? (deps.getLaunchProfile?.(task.profileId, task.createdBy) ?? null) : null
  const applied = applyOrderToRequest(buildSpawnRequest(task, profile, firedAt), order)
  // An order that asks for more privilege than the scheduler holds is a FAILED
  // fire, not a quiet downgrade: dispatching the seat with caps its order did
  // not describe is worse than not dispatching it, and the failure counter is
  // what eventually disarms a schedule nobody is fixing.
  if (!applied.ok) return { ok: false, reason: applied.reason }
  return { ok: true, run: () => deps.dispatch(applied.request), outcome: 'spawned' }
}

/** The still-running conversation from this schedule's most recent spawn, if any. */
function liveConversationFor(task: ScheduledTask, deps: FireDeps): string | null {
  const last = deps.lastSpawnedConversationId(task.id)
  if (!last) return null
  return deps.isConversationAlive(last) ? last : null
}

/**
 * Bookkeeping after a dispatch attempt. `lastFiredMinuteKey` is deliberately NOT
 * touched here -- the engine stamps it BEFORE awaiting, which is what stops a
 * slow dispatch from being fired twice by the next tick.
 */
function settleTask(
  task: ScheduledTask,
  deps: FireDeps,
  opts: { dispatchOk: boolean; firedAt: number },
): ScheduledTask {
  const failure = nextFailureState(task.consecutiveFailures, opts.dispatchOk)
  if (failure.disable) {
    console.warn(
      `[sched] disarmed id=${task.id} name="${task.name}" after ${failure.consecutiveFailures} consecutive dispatch failures`,
    )
    deps.notify?.(`Schedule "${task.name}" disabled after ${failure.consecutiveFailures} failed launches`)
  }
  return {
    ...task,
    lastRunAt: opts.firedAt,
    runCount: opts.dispatchOk ? task.runCount + 1 : task.runCount,
    consecutiveFailures: failure.consecutiveFailures,
    enabled: failure.disable ? false : task.enabled,
    updatedAt: deps.now(),
  }
}

/** Record the run + log it. Every exit from `fireSchedule` goes through here. */
function finish(
  task: ScheduledTask,
  deps: FireDeps,
  opts: FireOptions,
  firedAt: number,
  result: FireResult,
  jobId?: string,
): FireResult {
  const run: ScheduledRun = {
    id: newScheduledRunId(),
    scheduleId: task.id,
    firedAt,
    minuteKey: opts.minuteKey,
    trigger: opts.trigger,
    outcome: result.outcome,
    conversationId: result.conversationId,
    jobId,
    error: result.error,
  }
  deps.recordRun(run)
  console.log(
    `[sched] fire id=${task.id} name="${task.name}" project=${task.projectUri} cron="${task.cron}" tz=${task.tz} ` +
      `minute=${opts.minuteKey} trigger=${opts.trigger} outcome=${result.outcome} ` +
      `conv=${result.conversationId?.slice(0, 8) ?? '-'} job=${jobId?.slice(0, 8) ?? '-'}` +
      (result.error ? ` error="${result.error}"` : ''),
  )
  return result
}

/**
 * Fire one schedule. The caller has already decided it is DUE and stamped
 * `lastFiredMinuteKey`; everything from here on is this function's business.
 */
export async function fireSchedule(task: ScheduledTask, deps: FireDeps, opts: FireOptions): Promise<FireResult> {
  const firedAt = opts.firedAt ?? deps.now()

  // A schedule must never outlive the permission that authorised it, so the
  // owner's rights are re-checked at every fire rather than trusted from create.
  if (!deps.ownerMaySpawn(task.createdBy)) {
    deps.persist({ ...task, enabled: false, updatedAt: deps.now() })
    deps.notify?.(`Schedule "${task.name}" disabled: ${task.createdBy} no longer has spawn permission`)
    return finish(task, deps, opts, firedAt, {
      outcome: 'error',
      error: `owner "${task.createdBy}" no longer has spawn permission`,
    })
  }

  // OPT-IN, RE-CHECKED AT EVERY FIRE, exactly like the owner's grants above and
  // for the same reason: a project that opts out after a schedule was armed must
  // stop being swept. `skipped_disabled` rather than `error` on purpose -- an
  // opted-out project is a schedule correctly declining to run, and counting
  // that as a dispatch failure would disarm it after five quiet mornings.
  if (!isSpawnSchedule(task) && !deps.morningReportEnabled?.(task.projectUri)) {
    return finish(task, deps, opts, firedAt, {
      outcome: 'skipped_disabled',
      error: `the morning report is not enabled for ${task.projectUri}`,
    })
  }

  if (task.overlap === 'skip') {
    const live = liveConversationFor(task, deps)
    if (live) return finish(task, deps, opts, firedAt, { outcome: 'skipped_overlap', conversationId: live })
  }

  // The order this schedule spends -- decides both its share of the pool and
  // the caps its spawn runs under. Absent for every schedule that names none.
  const order = seatOrder(task.orderId)
  const admission = decideSeatAdmission({
    order,
    census: { total: deps.inFlight(), forOrder: order ? deps.inFlightForOrder(order.order.id) : 0 },
    maxInFlight: deps.maxInFlight,
  })
  if (!admission.admit) {
    return finish(task, deps, opts, firedAt, { outcome: 'skipped_overlap', error: admission.reason })
  }

  const plan = planFire(task, deps, firedAt, order)
  if (!plan.ok) {
    deps.persist(settleTask(task, deps, { dispatchOk: false, firedAt }))
    return finish(task, deps, opts, firedAt, { outcome: 'error', error: plan.reason })
  }

  // Claimed here, released in the `finally`: everything that could still refuse
  // this fire has already run, and nothing between the claim and the dispatch
  // awaits, so a sibling due in the same minute sees the slot taken.
  const releaseSlot = deps.claimSlot(order?.order.id)
  let dispatched: DispatchOutcome
  try {
    dispatched = await plan.run()
  } catch (err) {
    // A throwing dispatch is a failed fire, not a crashed tick.
    dispatched = { ok: false, error: err instanceof Error ? err.message : String(err) }
  } finally {
    releaseSlot()
  }

  deps.persist(settleTask(task, deps, { dispatchOk: dispatched.ok, firedAt }))

  return finish(
    task,
    deps,
    opts,
    firedAt,
    dispatched.ok
      ? { outcome: plan.outcome, conversationId: dispatched.conversationId }
      : { outcome: 'error', error: dispatched.error ?? 'dispatch failed' },
    dispatched.jobId,
  )
}
