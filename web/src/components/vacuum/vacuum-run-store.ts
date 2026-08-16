/**
 * The vacuum RUN -- owned outside the view, because the run outlives the view.
 *
 * The step stream used to be a `useState` inside the workbench body with a
 * `window.addEventListener` next to it. That tied a run that takes minutes on
 * the broker to the lifetime of a React subtree: park the window (or close it)
 * and the listener went with it, so steps for a run still executing were dropped
 * on the floor and the log came back empty.
 *
 * A run belongs to the page, not to whoever happens to be rendering it. The
 * listener is attached once, on the first run, and stays.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import { create } from 'zustand'
import { runVacuumApply, runVacuumPlan } from './use-vacuum'
import type { VacuumSelection } from './vacuum-types'

export type VacuumRunMode = 'plan' | 'apply'

interface VacuumRunState {
  /** The run in flight, or the last one that finished. */
  mode: VacuumRunMode | null
  running: boolean
  steps: VacuumStepMessage[]
  /** The request itself failed (the run may never have started). */
  error: string | null
}

export const useVacuumRunStore = create<VacuumRunState>(() => ({
  mode: null,
  running: false,
  steps: [],
  error: null,
}))

let listening = false

/** Attach the step stream once, for the life of the page. */
function listen(): void {
  if (listening) return
  listening = true
  window.addEventListener('vacuum-step', e => {
    const detail = (e as CustomEvent<VacuumStepMessage>).detail
    useVacuumRunStore.setState(s => ({ steps: [...s.steps, detail] }))
  })
}

const POST: Record<VacuumRunMode, (selection: VacuumSelection) => Promise<unknown>> = {
  plan: runVacuumPlan,
  apply: runVacuumApply,
}

/** Start a run. Resolves when the broker call settles, NOT when the UI is done. */
export async function startVacuumRun(mode: VacuumRunMode, selection: VacuumSelection): Promise<void> {
  listen()
  useVacuumRunStore.setState({ mode, running: true, steps: [], error: null })
  try {
    await POST[mode](selection)
    useVacuumRunStore.setState({ running: false })
  } catch (e) {
    useVacuumRunStore.setState({ running: false, error: (e as Error).message })
  }
}
