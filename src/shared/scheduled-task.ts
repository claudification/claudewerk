/**
 * SCHEDULED TASK -- a cron-triggered spawn bound to a project.
 *
 * Vocabulary (the obvious words are all taken in this repo):
 *   SCHEDULE (`sch_`)     the persistent record: when + where + what
 *   RUN      (`schrun_`)  one firing of a schedule, a row of history
 *   jobId                 UNCHANGED -- the per-launch progress correlation id
 *
 * The `spawn` field deliberately mirrors `LaunchProfile['spawn']`: the same
 * partial spawn snapshot, so the control panel drives both with the same editor
 * components and a schedule can inherit from a launch profile without a
 * translation layer.
 *
 * Consumers:
 *   - Broker store:   src/broker/store/sqlite/scheduled-tasks.ts
 *   - Engine:         src/broker/scheduled-tasks/engine.ts
 *   - HTTP routes:    src/broker/scheduled-tasks/routes.ts
 *   - Control panel:  web/src/components/scheduled-tasks/
 */

import { z } from 'zod'
import { parseCron } from './cron-parse'
import { isValidTimeZone } from './cron-time'
import { spawnRequestSchema } from './spawn-schema'

const SCHEDULED_TASK_ID_PREFIX = 'sch_'
const SCHEDULED_RUN_ID_PREFIX = 'schrun_'

const SCHEDULE_MAX_PROMPT = 64 * 1024
export const SCHEDULE_MAX_COUNT = 200

/**
 * Reusable spawn DEFAULTS, never per-launch identifiers: `cwd` lives on the
 * schedule itself (it is fixed for a project) and `jobId` is minted per fire.
 */
const scheduleSpawnSchema = spawnRequestSchema.omit({ cwd: true, jobId: true }).partial()
export type ScheduleSpawn = z.infer<typeof scheduleSpawnSchema>

/**
 * What a new schedule spawns with unless the user says otherwise: a headless,
 * fire-and-forget worker. `adHoc` is the seam that makes it EXIT after its turn
 * (see `shouldExitAfterResult`) instead of idling until the watchdog reaps it --
 * without it, every scheduled run leaks a live session.
 */
export const DEFAULT_SCHEDULE_SPAWN: ScheduleSpawn = {
  adHoc: true,
  leaveRunning: false,
  headless: true,
  transport: 'claude-headless',
}

/** What to do when a fire is missed (broker down, machine asleep). */
const CATCH_UP_MODES = ['skip', 'once'] as const
/** What to do when the previous run is still going. */
const OVERLAP_MODES = ['skip', 'parallel'] as const

export const scheduledTaskSchema = z.object({
  id: z.string().startsWith(SCHEDULED_TASK_ID_PREFIX),
  name: z.string().min(1, 'name is required').max(64),
  enabled: z.boolean(),

  // -- WHERE --
  /** IDENTITY: indexing, badge matching, permission scoping. */
  projectUri: z.string().min(1, 'projectUri is required'),
  /** OPAQUE passthrough to the sentinel. The broker never parses this (cwd covenant). */
  cwd: z.string().min(1, 'cwd is required'),
  sentinel: z.string().max(128).optional(),

  // -- WHEN -- exactly one of `cron` (repeating) or `runAt` (one-shot).
  /** Repeating: a 5-field cron expression, evaluated in `tz`. */
  cron: z.string().max(128).optional(),
  /**
   * ONE-SHOT: the exact instant to fire, epoch ms.
   *
   * An INSTANT, not a wall clock, deliberately: a one-time run has a single
   * unambiguous moment, so storing epoch ms sidesteps DST entirely (no gap to
   * fall into, no repeated hour to dedupe). The editor converts the wall clock
   * you pick, in the zone you pick, into this instant -- and refuses a time
   * that does not exist in that zone.
   */
  runAt: z.number().int().nonnegative().optional(),
  /** IANA zone. REQUIRED for both kinds: it is how the time is DISPLAYED, and
   *  for a cron it is also how the time is EVALUATED (the container is UTC). */
  tz: z.string().min(1, 'tz is required'),
  startAt: z.number().int().nonnegative().optional(),
  endAt: z.number().int().nonnegative().optional(),
  maxRuns: z.number().int().positive().optional(),
  catchUp: z.enum(CATCH_UP_MODES).default('skip'),
  overlap: z.enum(OVERLAP_MODES).default('skip'),

  // -- WHAT --
  /**
   * WHICH KIND OF WORK this schedule fires. Absent = `spawn`, which is what
   * every schedule written before this field existed meant.
   *
   * `board-sweep` runs the morning report's board op against the sentinel and
   * launches NO conversation. It is a schedule rather than its own timer on
   * purpose: cron parsing, the required IANA zone, missed-fire reconciliation,
   * the 3-in-flight ceiling, the owner re-check and the run history are all
   * rules about firing unattended work, none of them are rules about spawning,
   * and a second scheduler would have had to re-implement every one.
   *
   * OPTIONAL rather than `.default('spawn')` on purpose: every schedule stored
   * before this field existed genuinely has no `action`, and a default would
   * make the type claim otherwise. `isSpawnSchedule` is the one place that
   * absence is read as `spawn`.
   */
  action: z.enum(['spawn', 'board-sweep']).optional(),
  /**
   * The prompt a `spawn` schedule launches with. REQUIRED for `spawn` (enforced
   * in `checkAction` -- a spawn schedule with no prompt has nothing to run) and
   * meaningless for `board-sweep`, whose work is the op, not a sentence.
   */
  prompt: z.string().max(SCHEDULE_MAX_PROMPT, 'prompt exceeds 64 KB').optional(),
  profileId: z.string().optional(),
  spawn: scheduleSpawnSchema,
  /**
   * The WORK ORDER this schedule spends -- `REFINER@1` and nothing else, today.
   *
   * The order supplies the seat's caps (model, effort, budget, deny rules) and
   * its share of the scheduler's concurrency pool. Absent is the ordinary case
   * and means what it always meant: the schedule's own `spawn` snapshot, bounded
   * by the global ceiling alone.
   *
   * Kept as a plain id rather than an inlined order so a cap change is one edit
   * to the order and not a migration over every schedule that names it. An id no
   * build recognises is IGNORED, not an error -- a schedule must not go dark
   * because an order was renamed.
   */
  orderId: z.string().max(64).optional(),

  // -- WHO --
  createdBy: z.string().min(1),

  createdAt: z.number().int().nonnegative(),
  updatedAt: z.number().int().nonnegative(),
  lastRunAt: z.number().int().nonnegative().optional(),
  /** Zone-qualified wall-clock minute of the last fire -- the double-fire guard. */
  lastFiredMinuteKey: z.string().optional(),
  runCount: z.number().int().nonnegative().default(0),
  consecutiveFailures: z.number().int().nonnegative().default(0),
})
export type ScheduledTask = z.infer<typeof scheduledTaskSchema>

/** A schedule is either repeating or one-shot -- this is how you ask which. */
export function isOneShot(task: Pick<ScheduledTask, 'runAt'>): boolean {
  return task.runAt !== undefined
}

/** A schedule that launches a conversation, as opposed to running a board op. */
export function isSpawnSchedule(task: Pick<ScheduledTask, 'action'>): boolean {
  return (task.action ?? 'spawn') === 'spawn'
}

type WhenFields = Pick<ScheduledTask, 'cron' | 'runAt' | 'tz' | 'startAt' | 'endAt'>
type ActionFields = Pick<ScheduledTask, 'action' | 'prompt'>

/**
 * Cross-field rules a plain object schema cannot express.
 *
 * `nowMs` is injected so "runAt must be in the future" is testable and so the
 * SERVER's clock decides -- a browser with a skewed clock cannot smuggle a
 * past one-shot through, and one that is already due would otherwise fire the
 * instant it is saved.
 */
/**
 * EXACTLY one WHEN. Both would be ambiguous about which wins; neither could
 * never fire at all.
 */
function checkWhenKind(task: WhenFields, ctx: z.RefinementCtx): void {
  if (task.cron === undefined && task.runAt === undefined) {
    ctx.addIssue({ code: 'custom', message: 'set either a cron schedule or a one-time run time', path: ['cron'] })
    return
  }
  if (task.cron !== undefined && task.runAt !== undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'a schedule is either repeating (cron) or one-time (runAt), not both',
      path: ['runAt'],
    })
  }
}

/** Whichever WHEN is set has to be usable: a parseable cron, a future instant. */
function checkWhenValue(task: WhenFields, ctx: z.RefinementCtx, nowMs: number): void {
  if (task.cron !== undefined) {
    const cron = parseCron(task.cron)
    if (!cron.ok) ctx.addIssue({ code: 'custom', message: `cron: ${cron.error}`, path: ['cron'] })
  }
  if (task.runAt !== undefined && task.runAt <= nowMs) {
    ctx.addIssue({ code: 'custom', message: 'the one-time run time is in the past', path: ['runAt'] })
  }
}

/**
 * WHAT it fires has to be runnable. A `spawn` with no prompt would dispatch a
 * conversation with nothing to say; the old schema made `prompt` unconditionally
 * required, and this keeps that exact rule for every schedule that spawns while
 * letting a board op carry no prompt at all rather than a decorative one.
 */
function checkAction(task: ActionFields, ctx: z.RefinementCtx): void {
  if (!isSpawnSchedule(task)) return
  if (!task.prompt || task.prompt.trim() === '') {
    ctx.addIssue({ code: 'custom', message: 'prompt is required', path: ['prompt'] })
  }
}

/** Zone + window rules, shared by both kinds. */
function checkZoneAndWindow(task: WhenFields, ctx: z.RefinementCtx): void {
  if (!isValidTimeZone(task.tz)) {
    ctx.addIssue({ code: 'custom', message: `tz: "${task.tz}" is not a known IANA timezone`, path: ['tz'] })
  }
  if (task.startAt !== undefined && task.endAt !== undefined && task.endAt <= task.startAt) {
    ctx.addIssue({ code: 'custom', message: 'endAt must be after startAt', path: ['endAt'] })
  }
}

/**
 * Cross-field rules a plain object schema cannot express.
 *
 * `nowMs` is injected so "runAt must be in the future" is testable and so the
 * SERVER's clock decides -- a browser with a skewed clock cannot smuggle a past
 * one-shot through, and one already due would otherwise fire the moment it saved.
 */
function refineSchedule(task: WhenFields & ActionFields, ctx: z.RefinementCtx, nowMs: number = Date.now()): void {
  checkWhenKind(task, ctx)
  checkWhenValue(task, ctx, nowMs)
  checkZoneAndWindow(task, ctx)
  checkAction(task, ctx)
}

/**
 * The same rules MINUS the future check -- for validating a record that already
 * exists. A one-shot that has fired (or is mid-flight) has a `runAt` in the
 * past by definition, and re-saving it must not become impossible.
 */
function refineStoredSchedule(task: WhenFields & ActionFields, ctx: z.RefinementCtx): void {
  refineSchedule(task, ctx, 0)
}

/**
 * Validate a WHOLE record that already exists (the PATCH merge, mainly).
 *
 * Uses the stored variant on purpose: a one-shot that has already fired has a
 * `runAt` in the past, and re-validating it with the future check would make
 * even "disable this" impossible to save.
 */
export const validatedScheduledTaskSchema = scheduledTaskSchema.superRefine(refineStoredSchedule)

/** The body accepted by POST /api/scheduled-tasks -- the server owns ids and stamps. */
export const scheduledTaskCreateSchema = scheduledTaskSchema
  .omit({ id: true, createdBy: true, createdAt: true, updatedAt: true, runCount: true, consecutiveFailures: true })
  .extend({ enabled: z.boolean().default(true) })
  .superRefine(refineSchedule)
export type ScheduledTaskCreate = z.infer<typeof scheduledTaskCreateSchema>

/** The body accepted by PATCH -- any subset; what IS present is re-validated. */
export const scheduledTaskPatchSchema = scheduledTaskSchema
  .omit({ id: true, createdBy: true, createdAt: true, updatedAt: true })
  .partial()
  .superRefine((patch, ctx) => {
    if (patch.cron !== undefined) {
      const cron = parseCron(patch.cron)
      if (!cron.ok) ctx.addIssue({ code: 'custom', message: `cron: ${cron.error}`, path: ['cron'] })
    }
    // Explicitly RE-scheduling a one-shot means picking a future moment. (The
    // engine never patches through this schema, so a fired runAt is untouched.)
    if (patch.runAt !== undefined && patch.runAt <= Date.now()) {
      ctx.addIssue({ code: 'custom', message: 'the one-time run time is in the past', path: ['runAt'] })
    }
    if (patch.tz !== undefined && !isValidTimeZone(patch.tz)) {
      ctx.addIssue({ code: 'custom', message: `tz: "${patch.tz}" is not a known IANA timezone`, path: ['tz'] })
    }
  })
export type ScheduledTaskPatch = z.infer<typeof scheduledTaskPatchSchema>

export function newScheduledTaskId(): string {
  // Web Crypto -- `node:crypto` does not survive the control-panel bundle.
  return `${SCHEDULED_TASK_ID_PREFIX}${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
}
