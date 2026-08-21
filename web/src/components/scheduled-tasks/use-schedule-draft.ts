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

import { viewerTimeZone } from '@shared/format-when'
import { DEFAULT_SENTINEL_NAME, tryParseProjectUri } from '@shared/project-uri'
import {
  DEFAULT_SCHEDULE_SPAWN,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduleSpawn,
} from '@shared/scheduled-task'
import { useState } from 'react'
import { defaultRunAtLocal, resolveRunAt, toLocalInputValue } from './draft-time'

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

/**
 * Where a NEW schedule runs, read straight off the project URI
 * (`claude://{sentinel}/{path}`) -- the one place that already knows both.
 *
 * Deliberately NOT the project's most recent conversation: conversations
 * routinely run in `.claude/worktrees/<name>`, and seeding from one would arm a
 * schedule against a path that disappears when the worktree is cleaned up --
 * leaving it to fire into nothing months later. The project root is the only
 * durable answer; a subdirectory is an opt-in the user types.
 *
 * The sentinel is left UNDEFINED for the default host, because that is how the
 * broker is told "you pick" (`spawn-dispatch` falls back to the default
 * sentinel). It is only pinned when the project lives somewhere else -- absent
 * that, a schedule on a project hosted by `laptop` would fire on the default
 * host, in a directory that may not even exist there.
 */
export function projectDefaults(projectUri: string): { cwd: string; sentinel?: string } {
  const parsed = projectUri ? tryParseProjectUri(projectUri) : null
  if (!parsed) return { cwd: '' }
  const authority = parsed.authority
  return {
    cwd: parsed.path,
    sentinel: authority && authority !== DEFAULT_SENTINEL_NAME ? authority : undefined,
  }
}

/** A new schedule: repeating, ad-hoc, armed, in the viewer's own timezone.
 *  `cwd` defaults to the project root; pass one to override it. */
export function blankDraft(projectUri: string, cwd?: string): ScheduleDraft {
  // The creating browser's zone, never the server's -- the server is UTC.
  const tz = viewerTimeZone()
  const defaults = projectDefaults(projectUri)
  return {
    name: '',
    prompt: '',
    mode: 'repeating',
    cron: '0 9 * * 1-5',
    runAtLocal: defaultRunAtLocal(tz),
    tz,
    projectUri,
    cwd: cwd || defaults.cwd,
    sentinel: defaults.sentinel,
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    overlap: 'skip',
    catchUp: 'skip',
    enabled: true,
  }
}

export function draftFromTask(task: ScheduledTask): ScheduleDraft {
  // The STORED cwd/sentinel win outright. Re-deriving here would silently snap
  // a schedule aimed at a subdirectory back to the project root on every edit.
  const blank = blankDraft(task.projectUri, task.cwd)
  return {
    ...blank,
    name: task.name,
    // A `board-sweep` schedule carries no prompt -- its work is a board op, not
    // a sentence. The editor only ever creates spawn schedules, and its own
    // validation still demands one, so this coalesce is about RENDERING a record
    // this panel did not write.
    prompt: task.prompt ?? '',
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
  // Order matters: with no project there is nothing to derive a directory FROM,
  // so complaining about the directory would send the user to fix the symptom.
  if (!draft.projectUri.trim()) return 'Pick a project for this schedule'
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
