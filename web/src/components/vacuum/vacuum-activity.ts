/**
 * What the parked Vacuum tile says.
 *
 * Pure, and ordered deliberately: a failure outranks a run, a run outranks a
 * measurement, and only a run that actually produced steps can report `done`.
 *
 * There is NO progress fraction here, and that is a decision rather than an
 * omission: the step count has no honest denominator (it depends on how many
 * months turn out to be eligible), and a bar that guesses is worse than a bar
 * that isn't there.
 */

import type { VacuumStepMessage } from '@shared/protocol'
import type { SurfaceActivityInput } from '@/hooks/modal-manager-types'
import type { VacuumRunMode } from './vacuum-run-store'

export interface VacuumWork {
  mode: VacuumRunMode | null
  running: boolean
  steps: VacuumStepMessage[]
  /** The run request itself failed. */
  error: string | null
  /** The estimate is being (re-)measured. */
  loading: boolean
  /** The ~2 minute byte pass. */
  measuringBytes: boolean
}

const RUN_VERB: Record<VacuumRunMode, string> = { plan: 'dry run', apply: 'vacuuming' }

function running(label: string, tick: number): SurfaceActivityInput {
  return { status: 'running', label, tick }
}

export function vacuumActivity(work: VacuumWork): SurfaceActivityInput {
  const { mode, steps } = work
  if (work.error) return { status: 'error', label: work.error }

  if (mode && work.running) {
    const verb = RUN_VERB[mode]
    const last = steps.at(-1)
    return running(last ? `${verb}: ${last.step}` : `${verb}: starting`, steps.length)
  }

  if (work.measuringBytes) return running('measuring bytes', steps.length)
  if (work.loading) return running('measuring', steps.length)

  if (mode && steps.length > 0) {
    const failed = steps.find(s => s.status === 'failed')
    if (failed) return { status: 'error', label: `${RUN_VERB[mode]} failed: ${failed.step}`, tick: steps.length }
    return { status: 'done', label: `${RUN_VERB[mode]}: ${steps.length} steps`, tick: steps.length }
  }

  return { status: 'idle' }
}
