/**
 * Opener + view state for the scheduled-tasks modal.
 *
 * One global, parkable surface (not one modal per project): the whole point is
 * seeing every schedule at once. Opening from a project just pre-filters the
 * list, which is why the filter lives here rather than in the modal's scope.
 *
 * Mirrors `use-nightshift-modal.ts` -- same managed-modal registration idiom.
 */

import { create } from 'zustand'
import { useModalManagerStore } from '@/hooks/use-modal-manager'

const SCHEDULED_TASKS_MODAL = { id: 'scheduled-tasks', kind: 'scheduled-tasks', title: 'Scheduled Tasks' }

interface ScheduledTasksModalState {
  /** Only show schedules for this project. Undefined = all projects. */
  projectFilter?: string
  /** The schedule open in the detail pane. */
  selectedId?: string
  /** Editing an existing schedule, drafting a new one, or just browsing. */
  mode: 'browse' | 'edit' | 'create'
  setProjectFilter: (uri?: string) => void
  select: (id?: string) => void
  setMode: (mode: 'browse' | 'edit' | 'create') => void
}

export const useScheduledTasksModalStore = create<ScheduledTasksModalState>(set => ({
  mode: 'browse',
  setProjectFilter: projectFilter => set({ projectFilter }),
  select: selectedId => set({ selectedId, mode: 'browse' }),
  setMode: mode => set({ mode }),
}))

/** Open (or re-focus) the modal, optionally filtered to one project. */
export function openScheduledTasksModal(projectUri?: string): void {
  useScheduledTasksModalStore.getState().setProjectFilter(projectUri)
  useModalManagerStore.getState().open(SCHEDULED_TASKS_MODAL, { type: 'global' })
}
