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
import {
  newScheduledRunId,
  type RunOutcome,
  type RunTrigger,
  type ScheduledRun,
  type ScheduledTask,
} from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { nextFailureState } from './policy'

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
  /** Scheduler-originated spawns currently in flight, for the global ceiling. */
  inFlight(): number
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

  if (deps.inFlight() >= deps.maxInFlight) {
    return finish(task, deps, opts, firedAt, {
      outcome: 'skipped_overlap',
      error: `scheduler at its concurrency ceiling (${deps.maxInFlight})`,
    })
  }

  const profile = task.profileId ? (deps.getLaunchProfile?.(task.profileId, task.createdBy) ?? null) : null
  const request = buildSpawnRequest(task, profile, firedAt)

  let dispatched: DispatchOutcome
  try {
    dispatched = await deps.dispatch(request)
  } catch (err) {
    // A throwing dispatch is a failed fire, not a crashed tick.
    dispatched = { ok: false, error: err instanceof Error ? err.message : String(err) }
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
