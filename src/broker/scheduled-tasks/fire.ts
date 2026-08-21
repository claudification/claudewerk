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
import { composeSeatPrompt, type Order } from '../../shared/order'
import { composeOrderCaps, internalOrderCaller } from '../../shared/order-caps'
import { seatOrder } from '../../shared/refiner-order'
import { newScheduledRunId, type RunOutcome, type RunTrigger, type ScheduledRun } from '../../shared/scheduled-run'
import { type ScheduledTask, scheduleAction } from '../../shared/scheduled-task'
import type { SpawnRequest } from '../../shared/spawn-schema'
import { applyDenyFloor, buildUnattendedSettings } from '../../shared/unattended-permissions'
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
   * Arm the epic run an `epic-start` schedule names.
   *
   * OPTIONAL for the same reason as `runBoardSweep`, and absent means the same
   * thing: a FAILED fire with a reason, never a silent no-op. A schedule that
   * reports success and arms nothing is indistinguishable from one that works,
   * right up until the morning nobody's epic ran.
   */
  startEpicRun?(task: ScheduledTask): Promise<DispatchOutcome>
  /**
   * Is the morning report opted in for this project? OFF BY DEFAULT: absent, or
   * returning false, refuses the fire. A sweep that switched itself on would be
   * an unattended agent re-filing cards in a repo nobody opted in.
   */
  morningReportEnabled?(projectUri: string): boolean
  /**
   * The SAME question for an `epic-start`: is the "epics" scanner ticked for
   * this project? Answers with the refusal text or null, because the wording is
   * the value -- it names the box and where to tick it.
   *
   * Asked HERE as well as inside the arm, deliberately. The arm has to refuse
   * (the route arms too, and a human deserves the refusal at the click), but a
   * schedule that learned it only from the arm would count five refusals as five
   * dispatch failures and disarm itself over a box somebody unticked on purpose.
   * `skipped_disabled` is a schedule correctly declining to run.
   */
  epicsScannerRefusal?(projectUri: string): string | null
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
 *
 * THE ORDER'S INSTRUCTION BLOCK IS FOLDED INTO THE PROMPT HERE, and here is the
 * only place a scheduled fire has one. An `order@1` for a seat no broker builder
 * covers carries its own `instructions` (`REFINER@1` is the first), and until
 * something turns that field into prompt text a schedule naming such an order
 * gets the seat's CAPS and never its definition -- a refiner that was never told
 * to drain the tag, running on a refiner's budget.
 *
 * NOT IN `applyOrderToRequest`, DELIBERATELY. That function is shared with
 * `refine-scanner.ts`, which composes its own prompt from the same block
 * (`buildRefinerPrompt`) because it has a CARD to point at and no schedule
 * prompt at all. Folding the block in there too would hand that seat its
 * instructions twice. The caps composition is genuinely common to both callers;
 * the prompt is not, and pretending otherwise is how a shared function grows a
 * flag.
 */
export function buildSpawnRequest(
  task: ScheduledTask,
  profile: LaunchProfile | null,
  firedAt: number,
  order?: Order,
): SpawnRequest {
  const stamp = new Date(firedAt).toISOString().slice(0, 16).replace('T', ' ')
  return {
    ...(profile?.spawn ?? {}),
    ...task.spawn,
    cwd: task.cwd,
    // `?? ''` never fires for a spawn schedule -- `checkAction` rejects one with
    // no prompt at both create and PATCH. It is here because the field became
    // optional for `board-sweep`, which does not reach this function at all.
    prompt: composeSeatPrompt(order, task.prompt ?? ''),
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
 * THE TURN CEILING RIDES ALONG WITH THE BUDGET. `caps.maxTurns` composes
 * exactly like `maxBudgetUsd` -- `min()` with whatever the request already
 * carried -- and lands on the `SpawnRequest`, which the sentinel spends as CC's
 * `--max-turns`. Before `order-caps-turns-and-reservation` the number existed
 * on a wrapper type beside the order and nothing downstream read it, which is
 * the same inertness as a deny rule nobody applies.
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
export function applyOrderToRequest(request: SpawnRequest, order: Order | undefined): OrderApplication {
  if (order === undefined) return { ok: true, request }
  const existing = inlineDeny(request.settingsInline)
  if (!existing.ok) {
    return {
      ok: false,
      reason: `order ${order.id}: cannot apply its deny rules -- ${existing.reason}`,
    }
  }
  const composed = composeOrderCaps(
    order,
    {
      model: request.model,
      effort: request.effort,
      agent: request.agent,
      mcpConfigPath: request.mcpConfigPath,
      maxBudgetUsd: request.maxBudgetUsd,
      maxTurns: request.maxTurns,
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

/**
 * WHAT this fire actually does, resolved before a slot is claimed.
 *
 * Three actions, one fire path. Everything around this -- the owner re-check,
 * the overlap rule, seat admission, the run row, the failure backoff -- is
 * shared because those are rules about firing unattended work, and none of them
 * is a rule about spawning. Only the middle differs, so only the middle branches.
 */
type FirePlan = { ok: true; run: () => Promise<DispatchOutcome>; outcome: RunOutcome } | { ok: false; reason: string }

/**
 * The two actions that launch NO conversation, or null when this one spawns.
 *
 * Each needs a runner wired, and a missing one is a FAILED fire with a reason
 * rather than a quiet success -- see `FireDeps.runBoardSweep` and
 * `FireDeps.startEpicRun`. Neither builds a `SpawnRequest`, which is why they
 * resolve here, before the whole spawn half of `planFire`.
 */
function planNonSpawn(task: ScheduledTask, deps: FireDeps): FirePlan | null {
  const action = scheduleAction(task)
  if (action === 'board-sweep') {
    const run = deps.runBoardSweep
    if (!run) return { ok: false, reason: 'this broker has no board-sweep runner wired' }
    return { ok: true, run: () => run(task), outcome: 'swept' }
  }
  if (action === 'epic-start') {
    const run = deps.startEpicRun
    if (!run) return { ok: false, reason: 'this broker has no epic-start runner wired' }
    return { ok: true, run: () => run(task), outcome: 'armed' }
  }
  return null
}

function planFire(task: ScheduledTask, deps: FireDeps, firedAt: number, order: Order | undefined): FirePlan {
  const nonSpawn = planNonSpawn(task, deps)
  if (nonSpawn) return nonSpawn

  const profile = task.profileId ? (deps.getLaunchProfile?.(task.profileId, task.createdBy) ?? null) : null
  const applied = applyOrderToRequest(buildSpawnRequest(task, profile, firedAt, order), order)
  // An order that asks for more privilege than the scheduler holds is a FAILED
  // fire, not a quiet downgrade: dispatching the seat with caps its order did
  // not describe is worse than not dispatching it, and the failure counter is
  // what eventually disarms a schedule nobody is fixing.
  if (!applied.ok) return { ok: false, reason: applied.reason }

  // The floor goes on last and applies to every SPAWNING fire, order or no
  // order. It lives in this branch rather than in `fireSchedule` because it
  // takes a `SpawnRequest`, and the other branch never builds one -- see the
  // non-spawning arms above and the note on `FloorApplication` below.
  const floored = applyDenyFloorToRequest(applied.request)
  if (!floored.ok) return { ok: false, reason: floored.reason }
  return { ok: true, run: () => deps.dispatch(floored.request), outcome: 'spawned' }
}

type FloorApplication = { ok: true; request: SpawnRequest } | { ok: false; reason: string }

/**
 * THE DENY-FLOOR ON EVERY SCHEDULED FIRE, ORDER OR NO ORDER.
 *
 * The floor -- force-push, push to mainline, `sudo`, process kills, external
 * sends -- used to reach a scheduled seat by exactly one accident: it rides
 * inside `buildUnattendedSettings`, which `applyOrderToRequest` called only when
 * the request had no `settingsInline` of its own. So a schedule that named no
 * order had never had the floor, and a schedule carrying its own fragment kept
 * whatever floor that fragment declared, which was usually none.
 *
 * THE POPULATION IS "NOBODY IS WATCHING", NOT "IS A QUEST LEG". `docs/scheduled-
 * tasks.md` § Security already settles this for the neighbouring question: "a
 * schedule IS a spawn -- one that fires later, unattended, with nobody at the
 * keyboard", which is why a scheduled fire runs with `bypassApprovalGate` and
 * why the owner's grants are re-checked at every fire. The floor is written for
 * exactly that population, so it is applied in `planFire`, to every fire that
 * SPAWNS, rather than inherited from whichever builder a seat happened to go
 * through.
 *
 * A `board-sweep` OR `epic-start` FIRE GETS NO FLOOR, AND IS NOT EXEMPT -- there
 * is nothing to apply one to. Neither branch launches a conversation or builds a
 * `SpawnRequest`: one sends a board op to the sentinel that owns the project and
 * the other arms an epic run, and both return a `DispatchOutcome`. This function
 * has no argument to take. The unattended work still happens beside the files,
 * gated per project by the scanner boxes (`FireDeps.morningReportEnabled`,
 * `FireDeps.epicsScannerRefusal`) and by the sentinel's own op allowlist -- a
 * different gate, in a different process, on a thing that is not a spawn. (The
 * seats an epic run later dispatches are built by the epic engine, which today
 * applies no floor of its own -- an arm through a schedule inherits exactly the
 * permissions an arm through the RUN button gets, no more.) If a future action
 * ever builds a request HERE, it goes through this floor.
 *
 * APPLIED AFTER THE ORDER, ON PURPOSE. The floor is a union and a union is
 * commutative, so going last cannot undo an order's rules -- and it keeps this
 * completely independent of `applyOrderToRequest`, which owns a different
 * question (what an order may narrow) and must stay free to answer it. `manual`
 * fires get the floor too: a "Run now" that tests a different permission surface
 * than the 03:00 fire is a test that lies.
 *
 * A `settingsPath` WITH NO `settingsInline` FAILS THE FIRE. The sentinel
 * materializes an inline fragment and lets it WIN over `settingsPath`
 * (`src/sentinel/index.ts`), so writing one here would silently throw away the
 * settings file a human pointed the schedule at -- most likely the allowlist
 * that makes its `dontAsk` seat able to do anything at all. Both alternatives
 * are quiet downgrades (drop the floor, or drop the human's file); a refusal
 * recorded in run history is the only one the human can see and fix.
 */
function applyDenyFloorToRequest(request: SpawnRequest): FloorApplication {
  if (request.settingsInline === undefined && request.settingsPath !== undefined) {
    return {
      ok: false,
      reason:
        'cannot apply the unattended deny-floor: this spawn carries a settingsPath and no settingsInline, ' +
        'and an inline fragment would silently replace that file -- move the settings inline',
    }
  }
  const floored = applyDenyFloor(request.settingsInline)
  if (!floored.ok) {
    return { ok: false, reason: `cannot apply the unattended deny-floor -- ${floored.reason}` }
  }
  return { ok: true, request: { ...request, settingsInline: floored.settings } }
}

/**
 * The scanner-fabric opt-out that applies to THIS action, as the sentence a
 * human reads in the run history -- or null when nothing is opting out.
 *
 * A `spawn` has no scanner behind it and is never gated here. The other two each
 * ride a box in Project Settings > Scanners, and each box is asked through the
 * predicate that owns it rather than through a second spelling of the default.
 */
function scannerOptOut(task: ScheduledTask, deps: FireDeps): string | null {
  const action = scheduleAction(task)
  if (action === 'board-sweep' && !deps.morningReportEnabled?.(task.projectUri)) {
    return `the morning report is not enabled for ${task.projectUri}`
  }
  if (action === 'epic-start') return deps.epicsScannerRefusal?.(task.projectUri) ?? null
  return null
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
  const optedOut = scannerOptOut(task, deps)
  if (optedOut) return finish(task, deps, opts, firedAt, { outcome: 'skipped_disabled', error: optedOut })

  if (task.overlap === 'skip') {
    const live = liveConversationFor(task, deps)
    if (live) return finish(task, deps, opts, firedAt, { outcome: 'skipped_overlap', conversationId: live })
  }

  // The order this schedule spends -- decides both its share of the pool and
  // the caps its spawn runs under. Absent for every schedule that names none.
  const order = seatOrder(task.orderId)
  const admission = decideSeatAdmission({
    order,
    census: { total: deps.inFlight(), forOrder: order ? deps.inFlightForOrder(order.id) : 0 },
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
  // A refused deny-floor arrives here as `!plan.ok`, above: `planFire` owns the
  // floor now (it is the branch that has a `SpawnRequest`), and both refusals
  // settle the task and finish `error` on the one path, exactly as before.

  // Claimed here, released in the `finally`: everything that could still refuse
  // this fire has already run, and nothing between the claim and the dispatch
  // awaits, so a sibling due in the same minute sees the slot taken.
  const releaseSlot = deps.claimSlot(order?.id)
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
