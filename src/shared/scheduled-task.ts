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
/** Runs kept per schedule before the reaper trims the tail. */
export const SCHEDULE_RUN_RETENTION = 200
export const SCHEDULE_RUN_RETENTION_MS = 90 * 24 * 60 * 60 * 1000

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

const RUN_TRIGGERS = ['cron', 'manual', 'catchup'] as const
const RUN_OUTCOMES = ['spawned', 'skipped_overlap', 'skipped_disabled', 'error', 'missed'] as const
export type RunTrigger = (typeof RUN_TRIGGERS)[number]
export type RunOutcome = (typeof RUN_OUTCOMES)[number]

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

  // -- WHEN --
  cron: z.string().min(1, 'cron is required').max(128),
  /** IANA zone. REQUIRED: the broker container runs in UTC, so an unzoned cron lies. */
  tz: z.string().min(1, 'tz is required'),
  startAt: z.number().int().nonnegative().optional(),
  endAt: z.number().int().nonnegative().optional(),
  maxRuns: z.number().int().positive().optional(),
  catchUp: z.enum(CATCH_UP_MODES).default('skip'),
  overlap: z.enum(OVERLAP_MODES).default('skip'),

  // -- WHAT --
  prompt: z.string().min(1, 'prompt is required').max(SCHEDULE_MAX_PROMPT, 'prompt exceeds 64 KB'),
  profileId: z.string().optional(),
  spawn: scheduleSpawnSchema,

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

/** Cross-field rules that a plain object schema cannot express. */
function refineSchedule(task: Pick<ScheduledTask, 'cron' | 'tz' | 'startAt' | 'endAt'>, ctx: z.RefinementCtx): void {
  const cron = parseCron(task.cron)
  if (!cron.ok) ctx.addIssue({ code: 'custom', message: `cron: ${cron.error}`, path: ['cron'] })
  if (!isValidTimeZone(task.tz)) {
    ctx.addIssue({ code: 'custom', message: `tz: "${task.tz}" is not a known IANA timezone`, path: ['tz'] })
  }
  if (task.startAt !== undefined && task.endAt !== undefined && task.endAt <= task.startAt) {
    ctx.addIssue({ code: 'custom', message: 'endAt must be after startAt', path: ['endAt'] })
  }
}

/** Validate at every entry point. Use the bare object schema only for `.omit()`/`.partial()`. */
export const validatedScheduledTaskSchema = scheduledTaskSchema.superRefine(refineSchedule)

/** The body accepted by POST /api/scheduled-tasks -- the server owns ids and stamps. */
export const scheduledTaskCreateSchema = scheduledTaskSchema
  .omit({ id: true, createdBy: true, createdAt: true, updatedAt: true, runCount: true, consecutiveFailures: true })
  .extend({ enabled: z.boolean().default(true) })
  .superRefine(refineSchedule)
export type ScheduledTaskCreate = z.infer<typeof scheduledTaskCreateSchema>

/** The body accepted by PATCH -- any subset; cron/tz are re-validated when present. */
export const scheduledTaskPatchSchema = scheduledTaskSchema
  .omit({ id: true, createdBy: true, createdAt: true, updatedAt: true })
  .partial()
  .superRefine((patch, ctx) => {
    if (patch.cron !== undefined) {
      const cron = parseCron(patch.cron)
      if (!cron.ok) ctx.addIssue({ code: 'custom', message: `cron: ${cron.error}`, path: ['cron'] })
    }
    if (patch.tz !== undefined && !isValidTimeZone(patch.tz)) {
      ctx.addIssue({ code: 'custom', message: `tz: "${patch.tz}" is not a known IANA timezone`, path: ['tz'] })
    }
  })
export type ScheduledTaskPatch = z.infer<typeof scheduledTaskPatchSchema>

/** One firing of a schedule -- a row of history. */
export interface ScheduledRun {
  id: string
  scheduleId: string
  firedAt: number
  minuteKey: string
  trigger: RunTrigger
  outcome: RunOutcome
  conversationId?: string
  jobId?: string
  error?: string
  endedAt?: number
  endStatus?: string
}

function shortId(): string {
  // Web Crypto -- `node:crypto` does not survive the control-panel bundle.
  return crypto.randomUUID().replace(/-/g, '').slice(0, 12)
}

export function newScheduledTaskId(): string {
  return `${SCHEDULED_TASK_ID_PREFIX}${shortId()}`
}

export function newScheduledRunId(): string {
  return `${SCHEDULED_RUN_ID_PREFIX}${shortId()}`
}

