/**
 * Client-side schedule state.
 *
 * One zustand store shared by the sidebar badge, the modal and the editor. The
 * broker pushes `scheduled_tasks_updated` on every change, so this is kept fresh
 * by the socket rather than polled (WS over HTTP) -- the initial fetch exists
 * only to populate a freshly-loaded tab.
 *
 * Selectors return primitives or stable references only. Returning a fresh array
 * or object literal from a zustand selector re-renders on every store touch and
 * eventually throws React #185; the badge subscribes on every project row, so
 * that mistake would be expensive here.
 */

import type { ScheduledRun } from '@shared/scheduled-run'
import type { ScheduledTask } from '@shared/scheduled-task'
import { create } from 'zustand'
import { fetchScheduledTasks } from './api'

interface ScheduledTasksState {
  tasks: ScheduledTask[]
  loaded: boolean
  loading: boolean
  /** Newest-first run history, per schedule id. Filled on demand by the modal. */
  runs: Record<string, ScheduledRun[]>
  setTasks: (tasks: ScheduledTask[]) => void
  setRuns: (scheduleId: string, runs: ScheduledRun[]) => void
  prependRun: (scheduleId: string, run: ScheduledRun) => void
  load: () => Promise<void>
}

const RUN_CAP = 200

export const useScheduledTasksStore = create<ScheduledTasksState>((set, get) => ({
  tasks: [],
  loaded: false,
  loading: false,
  runs: {},

  setTasks: tasks => set({ tasks, loaded: true }),

  setRuns: (scheduleId, runs) => set(state => ({ runs: { ...state.runs, [scheduleId]: runs } })),

  prependRun: (scheduleId, run) =>
    set(state => {
      const existing = state.runs[scheduleId]
      // Only track history we are already showing -- otherwise a busy schedule
      // would accumulate rows nobody has opened.
      if (!existing) return state
      if (existing.some(r => r.id === run.id)) return state
      return { runs: { ...state.runs, [scheduleId]: [run, ...existing].slice(0, RUN_CAP) } }
    }),

  async load() {
    if (get().loading) return
    set({ loading: true })
    try {
      set({ tasks: await fetchScheduledTasks(), loaded: true })
    } catch {
      // A failed load leaves the previous list in place; the WS push will
      // correct it. Never blank the UI over a transient fetch failure.
    } finally {
      set({ loading: false })
    }
  },
}))

/** WS: the full list changed. */
export function handleScheduledTasksUpdated(tasks: ScheduledTask[]): void {
  useScheduledTasksStore.getState().setTasks(tasks)
}

/** WS: one schedule fired. */
export function handleScheduledTaskRun(scheduleId: string, run: ScheduledRun | null): void {
  if (run) useScheduledTasksStore.getState().prependRun(scheduleId, run)
}
