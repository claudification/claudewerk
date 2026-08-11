/**
 * The schedule editor's draft state.
 *
 * Pulled out of the component so the form logic (defaults, patching, mapping to
 * and from the wire shape) is testable and the `.tsx` stays presentational.
 *
 * The spawn snapshot is the SAME shape a launch profile carries, which is what
 * lets the editor reuse `LaunchConfigFields` unmodified instead of growing a
 * second, drifting copy of the launch form.
 *
 * WHEN is held as the user typed it -- a cron string AND a datetime string, with
 * `mode` deciding which one counts. Keeping both means toggling Repeating <->
 * Once does not destroy what you already entered in the other one.
 */

import { wallClockToMs } from '@shared/cron-time'
import { viewerTimeZone } from '@shared/format-when'
import {
  DEFAULT_SCHEDULE_SPAWN,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduleSpawn,
} from '@shared/scheduled-task'
import { useState } from 'react'

export type ScheduleMode = 'repeating' | 'once'

export interface ScheduleDraft {
  name: string
  prompt: string
  mode: ScheduleMode
  cron: string
  /** `datetime-local` text ("2026-08-13T09:00"), read in `tz`. */
  runAtLocal: string
  tz: string
  projectUri: string
  cwd: string
  sentinel?: string
  profileId?: string
  spawn: ScheduleSpawn
  overlap: 'skip' | 'parallel'
  catchUp: 'skip' | 'once'
  maxRuns?: number
  enabled: boolean
}

/** `datetime-local` wants exactly "YYYY-MM-DDTHH:MM" in the TARGET zone. */
export function toLocalInputValue(ms: number, tz: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(new Date(ms))
  const get = (t: string) => parts.find(p => p.type === t)?.value ?? '00'
  return `${get('year')}-${get('month')}-${get('day')}T${(Number(get('hour')) % 24).toString().padStart(2, '0')}:${get('minute')}`
}

/**
 * Resolve the typed wall clock to an instant IN THE CHOSEN ZONE.
 *
 * `null` means the text is unparseable OR names a time that does not exist there
 * (the DST spring-forward gap) -- both are refusals, not silent corrections.
 */
export function resolveRunAt(runAtLocal: string, tz: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(runAtLocal.trim())
  if (!m) return null
  const [, year, month, day, hour, minute] = m
  return wallClockToMs(
    { year: Number(year), month: Number(month), day: Number(day), hour: Number(hour), minute: Number(minute) },
    tz,
  )
}

/** Default one-shot moment: the next whole hour, so the field is never empty. */
function defaultRunAtLocal(tz: string): string {
  const nextHour = Math.ceil((Date.now() + 60_000) / 3_600_000) * 3_600_000
  return toLocalInputValue(nextHour, tz)
}

/** A new schedule: repeating, ad-hoc, armed, in the viewer's own timezone. */
export function blankDraft(projectUri: string, cwd: string): ScheduleDraft {
  // The creating browser's zone, never the server's -- the server is UTC.
  const tz = viewerTimeZone()
  return {
    name: '',
    prompt: '',
    mode: 'repeating',
    cron: '0 9 * * 1-5',
    runAtLocal: defaultRunAtLocal(tz),
    tz,
    projectUri,
    cwd,
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    overlap: 'skip',
    catchUp: 'skip',
    enabled: true,
  }
}

export function draftFromTask(task: ScheduledTask): ScheduleDraft {
  const blank = blankDraft(task.projectUri, task.cwd)
  return {
    ...blank,
    name: task.name,
    prompt: task.prompt,
    mode: task.runAt !== undefined ? 'once' : 'repeating',
    // Keep the untouched side at its default so toggling mode offers something sane.
    cron: task.cron ?? blank.cron,
    runAtLocal: task.runAt !== undefined ? toLocalInputValue(task.runAt, task.tz) : blank.runAtLocal,
    tz: task.tz,
    sentinel: task.sentinel,
    profileId: task.profileId,
    spawn: task.spawn,
    overlap: task.overlap,
    catchUp: task.catchUp,
    maxRuns: task.maxRuns,
    enabled: task.enabled,
  }
}

export function draftToCreate(draft: ScheduleDraft): ScheduledTaskCreate {
  const once = draft.mode === 'once'
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    // EXACTLY one of these reaches the wire -- the server rejects both or neither.
    cron: once ? undefined : draft.cron.trim(),
    runAt: once ? (resolveRunAt(draft.runAtLocal, draft.tz) ?? undefined) : undefined,
    tz: draft.tz,
    projectUri: draft.projectUri,
    cwd: draft.cwd,
    sentinel: draft.sentinel,
    profileId: draft.profileId,
    spawn: draft.spawn,
    overlap: draft.overlap,
    catchUp: draft.catchUp,
    maxRuns: draft.maxRuns,
    enabled: draft.enabled,
  }
}

/** Client-side gate so Save cannot fire a request the server will just reject. */
export function draftProblem(draft: ScheduleDraft, nowMs: number = Date.now()): string | null {
  if (!draft.name.trim()) return 'Give the schedule a name'
  if (!draft.prompt.trim()) return 'A schedule needs a prompt -- that is what it runs'
  if (!draft.cwd.trim()) return 'Pick a working directory'

  if (draft.mode === 'once') {
    const runAt = resolveRunAt(draft.runAtLocal, draft.tz)
    if (runAt === null) {
      return draft.runAtLocal.trim()
        ? `${draft.runAtLocal} does not exist in ${draft.tz} -- the clocks skip that hour`
        : 'Pick when this should run'
    }
    if (runAt <= nowMs) return 'That moment has already passed'
    return null
  }

  if (!draft.cron.trim()) return 'Set a schedule'
  return null
}

export function useScheduleDraft(initial: ScheduleDraft) {
  const [draft, setDraft] = useState<ScheduleDraft>(initial)
  const patch = (next: Partial<ScheduleDraft>) => setDraft(prev => ({ ...prev, ...next }))
  return { draft, patch, setDraft }
}
