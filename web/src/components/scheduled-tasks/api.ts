/**
 * REST client for scheduled tasks.
 *
 * Thin on purpose: the store (`store.ts`) owns cached state and the WS broadcast
 * keeps it fresh, so these functions only ever fire a request and hand back what
 * the server said. Errors come back as values, not throws, for the mutating
 * calls -- the editor renders `error` inline next to the field that caused it.
 */

import type { ScheduledRun, ScheduledTask, ScheduledTaskCreate, ScheduledTaskPatch } from '@shared/scheduled-task'

export interface SaveScheduleResponse {
  ok: boolean
  scheduledTask?: ScheduledTask
  error?: string
}

async function readJson<T>(res: Response): Promise<T | null> {
  try {
    return (await res.json()) as T
  } catch {
    return null
  }
}

export async function fetchScheduledTasks(projectUri?: string): Promise<ScheduledTask[]> {
  const qs = projectUri ? `?project=${encodeURIComponent(projectUri)}` : ''
  const res = await fetch(`/api/scheduled-tasks${qs}`)
  if (!res.ok) throw new Error(`GET /api/scheduled-tasks -> ${res.status}`)
  const data = await readJson<{ scheduledTasks: ScheduledTask[] }>(res)
  return data?.scheduledTasks ?? []
}

export async function createScheduledTask(body: ScheduledTaskCreate): Promise<SaveScheduleResponse> {
  const res = await fetch('/api/scheduled-tasks', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await readJson<SaveScheduleResponse>(res)
  if (!res.ok) return { ok: false, error: data?.error ?? `POST /api/scheduled-tasks -> ${res.status}` }
  return data ?? { ok: true }
}

export async function patchScheduledTask(id: string, patch: ScheduledTaskPatch): Promise<SaveScheduleResponse> {
  const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  })
  const data = await readJson<SaveScheduleResponse>(res)
  if (!res.ok) return { ok: false, error: data?.error ?? `PATCH -> ${res.status}` }
  return data ?? { ok: true }
}

export async function deleteScheduledTask(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}`, { method: 'DELETE' })
  if (res.ok) return { ok: true }
  const data = await readJson<{ error?: string }>(res)
  return { ok: false, error: data?.error ?? `DELETE -> ${res.status}` }
}

export async function runScheduledTaskNow(id: string): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/run`, { method: 'POST' })
  const data = await readJson<{ error?: string }>(res)
  if (!res.ok) return { ok: false, error: data?.error ?? `run -> ${res.status}` }
  return { ok: true }
}

export async function fetchScheduledTaskRuns(id: string, limit = 50): Promise<ScheduledRun[]> {
  const res = await fetch(`/api/scheduled-tasks/${encodeURIComponent(id)}/runs?limit=${limit}`)
  if (!res.ok) throw new Error(`GET runs -> ${res.status}`)
  const data = await readJson<{ runs: ScheduledRun[] }>(res)
  return data?.runs ?? []
}
