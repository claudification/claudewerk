/**
 * The schedule editor's draft state.
 *
 * Pulled out of the component so the form logic (defaults, patching, mapping to
 * and from the wire shape) is testable and the `.tsx` stays presentational.
 *
 * The spawn snapshot is the SAME shape a launch profile carries, which is what
 * lets the editor reuse `LaunchConfigFields` unmodified instead of growing a
 * second, drifting copy of the launch form.
 */

import { viewerTimeZone } from '@shared/format-when'
import {
  DEFAULT_SCHEDULE_SPAWN,
  type ScheduledTask,
  type ScheduledTaskCreate,
  type ScheduleSpawn,
} from '@shared/scheduled-task'
import { useState } from 'react'

export interface ScheduleDraft {
  name: string
  prompt: string
  cron: string
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

/** A new schedule: ad-hoc, armed, in the viewer's own timezone. */
export function blankDraft(projectUri: string, cwd: string): ScheduleDraft {
  return {
    name: '',
    prompt: '',
    cron: '0 9 * * 1-5',
    // The creating browser's zone, never the server's -- the server is UTC.
    tz: viewerTimeZone(),
    projectUri,
    cwd,
    spawn: { ...DEFAULT_SCHEDULE_SPAWN },
    overlap: 'skip',
    catchUp: 'skip',
    enabled: true,
  }
}

export function draftFromTask(task: ScheduledTask): ScheduleDraft {
  return {
    name: task.name,
    prompt: task.prompt,
    cron: task.cron,
    tz: task.tz,
    projectUri: task.projectUri,
    cwd: task.cwd,
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
  return {
    name: draft.name.trim(),
    prompt: draft.prompt.trim(),
    cron: draft.cron.trim(),
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
export function draftProblem(draft: ScheduleDraft): string | null {
  if (!draft.name.trim()) return 'Give the schedule a name'
  if (!draft.prompt.trim()) return 'A schedule needs a prompt -- that is what it runs'
  if (!draft.cron.trim()) return 'Set a schedule'
  if (!draft.cwd.trim()) return 'Pick a working directory'
  return null
}

export function useScheduleDraft(initial: ScheduleDraft) {
  const [draft, setDraft] = useState<ScheduleDraft>(initial)
  const patch = (next: Partial<ScheduleDraft>) => setDraft(prev => ({ ...prev, ...next }))
  return { draft, patch, setDraft }
}
