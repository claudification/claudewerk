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
import type { ScheduledTask } from '../../shared/scheduled-task'
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
    prompt: task.prompt,
    sentinel: task.sentinel ?? profile?.sentinel,
    name: `${task.name} ${stamp}`.slice(0, 80),
    description: `Scheduled run of "${task.name}" (${task.cron} ${task.tz})`,
  }
}

export type OrderApplication = { ok: true; request: SpawnRequest } | { ok: false; reason: string }

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The deny rules already in the request's own fragment, or why they cannot be read. */
type InlineDeny = { ok: true; deny: string[] } | { ok: false; reason: string }

/**
 * Read the deny rules a caller's `settingsInline` already carries.
 *
 * `settingsInline` is an OPAQUE bag by schema (`Record<string, unknown>`), so
 * every step down into it is a shape that might not be there. A shape a union
 * cannot be expressed in returns a REASON rather than a guess: silently
 * treating a malformed `permissions` block as "no deny rules" and writing over
 * it is exactly the quiet downgrade this whole path exists to prevent.
 */
function inlineDeny(settings: Record<string, unknown> | undefined): InlineDeny {
  if (settings === undefined) return { ok: true, deny: [] }
  const permissions = settings.permissions
  if (permissions === undefined || permissions === null) return { ok: true, deny: [] }
  if (!isPlainObject(permissions)) return { ok: false, reason: 'settingsInline.permissions is not an object' }
  const deny = permissions.deny
  if (deny === undefined || deny === null) return { ok: true, deny: [] }
  if (!Array.isArray(deny) || deny.some(rule => typeof rule !== 'string')) {
    return { ok: false, reason: 'settingsInline.permissions.deny is not an array of strings' }
  }
  return { ok: true, deny: deny as string[] }
}

/**
 * The fragment with `deny` in it -- BUILT when the caller had none, PATCHED when
 * it had one.
 *
 * `deny` arrives already unioned (`composeOrderCaps` folded the caller's own
 * rules in), so assigning it is additive, never a replacement. Everything else
 * in the caller's fragment -- its allowlist, its hooks, keys this module has
 * never heard of -- is spread through untouched, because the order is entitled
 * to add a deny rule and to nothing else.
 *
 * A caller with NO fragment gets the full `buildUnattendedSettings` object,
 * which is also where the deny FLOOR lives. A caller WITH one keeps its own
 * floor: the order narrows what the caller configured, it does not re-configure
 * the harness around it (see `sched-settings-inline-deny-floor`).
 */
function withDenyRules(settings: Record<string, unknown> | undefined, deny: string[]): Record<string, unknown> {
  if (settings === undefined) return buildUnattendedSettings({ deny })
  const permissions = isPlainObject(settings.permissions) ? settings.permissions : {}
  return { ...settings, permissions: { ...permissions, deny } }
}

/**
 * Layer a work order's caps onto a spawn request.
 *
 * THE ORDER NEVER WINS OVER AN EXPLICIT CHOICE and never widens anything --
 * both rules belong to `composeOrderCaps`, which is called rather than
 * re-implemented so a scheduled seat gets byte-identical refusals to an epic
 * seat. What is left here is the mapping back onto a `SpawnRequest`.
 *
 * THE DENY RULES ARE UNIONED, NEVER SKIPPED. A schedule that already carries
 * its own `settingsInline` gets the order's rules merged INTO that fragment:
 * the caller's rules go in as `composeOrderCaps`' base so the union is the same
 * one every other order path uses, and the result is written back over
 * `permissions.deny` alone. Leaving the fragment alone instead -- which this
 * did until `order-deny-union-settings-inline` -- silently downgraded an
 * order's strongest guarantee to advice: `REFINER@1` denies the status verb so
 * a refiner CANNOT move a lane, and a refiner that quietly regained that verb
 * looks exactly like a correct run until a card lands in the wrong lane.
 *
 * A fragment whose shape cannot be unioned FAILS THE FIRE, naming the order,
 * matching what already happens when an order asks for more privilege than its
 * caller holds. Dispatching a seat with more privilege than its order allows is
 * the one outcome that must not happen here.
 */
export function applyOrderToRequest(request: SpawnRequest, order: SeatOrder | undefined): OrderApplication {
  if (order === undefined) return { ok: true, request }
  const existing = inlineDeny(request.settingsInline)
  if (!existing.ok) {
    return {
      ok: false,
      reason: `order ${order.order.id}: cannot apply its deny rules -- ${existing.reason}`,
    }
  }
  const composed = composeOrderCaps(
    order.order,
    {
      model: request.model,
      effort: request.effort,
      agent: request.agent,
      mcpConfigPath: request.mcpConfigPath,
      maxBudgetUsd: request.maxBudgetUsd,
      permissionMode: request.permissionMode as never,
      deny: existing.deny,
    },
    internalOrderCaller(),
  )
  if (!composed.ok) return { ok: false, reason: composed.reason }

  const { deny, ...caps } = composed.caps
  const next: SpawnRequest = { ...request, ...caps }
  // Membership, not length: a caller whose own deny list repeats a rule would
  // make a length comparison read "nothing was added" and drop the order's
  // rules on the floor -- the exact failure this card exists to close.
  const alreadyDenied = new Set(existing.deny)
  if (deny?.some(rule => !alreadyDenied.has(rule))) {
    next.settingsInline = withDenyRules(request.settingsInline, deny)
  }
  return { ok: true, request: next }
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

  const profile = task.profileId ? (deps.getLaunchProfile?.(task.profileId, task.createdBy) ?? null) : null
  const applied = applyOrderToRequest(buildSpawnRequest(task, profile, firedAt), order)
  // An order that asks for more privilege than the scheduler holds is a FAILED
  // fire, not a quiet downgrade: dispatching the seat with caps its order did
  // not describe is worse than not dispatching it, and the failure counter is
  // what eventually disarms a schedule nobody is fixing.
  if (!applied.ok) {
    deps.persist(settleTask(task, deps, { dispatchOk: false, firedAt }))
    return finish(task, deps, opts, firedAt, { outcome: 'error', error: applied.reason })
  }
  const request = applied.request

  // Claimed here, released in the `finally`: everything that could still refuse
  // this fire has already run, and nothing between the claim and the dispatch
  // awaits, so a sibling due in the same minute sees the slot taken.
  const releaseSlot = deps.claimSlot(order?.order.id)
  let dispatched: DispatchOutcome
  try {
    dispatched = await deps.dispatch(request)
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
      ? { outcome: 'spawned', conversationId: dispatched.conversationId }
      : { outcome: 'error', error: dispatched.error ?? 'dispatch failed' },
    dispatched.jobId,
  )
}
